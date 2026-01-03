// ステルスAI APIプロキシサーバー
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;

// multer設定（音声ファイルアップロード用）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB制限
});

// CORS設定
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 静的ファイルの配信
app.use(express.static(path.join(__dirname, 'dist')));

// ヘルスチェック
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ===========================================
// Whisper API プロキシ（音声→テキスト変換）
// ===========================================
app.post('/api/whisper', upload.single('file'), async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    console.error('[Proxy] OpenAI API key not configured');
    return res.status(500).json({ error: 'OpenAI API key not configured' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  console.log('[Proxy] Whisper request:', {
    fileSize: req.file.size,
    mimeType: req.file.mimetype,
    hasPrompt: !!req.body.prompt,
  });

  try {
    // multipart/form-data を手動で構築
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    
    const parts = [];
    
    // ファイルパート
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
      `Content-Type: ${req.file.mimetype || 'audio/wav'}\r\n\r\n`
    );
    parts.push(req.file.buffer);
    parts.push('\r\n');
    
    // modelパート
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `whisper-1\r\n`
    );
    
    // languageパート（日本語固定）
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language"\r\n\r\n` +
      `ja\r\n`
    );
    
    // response_formatパート
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `verbose_json\r\n`
    );
    
    // プロンプトパート（オプション）
    if (req.body.prompt) {
      const truncatedPrompt = req.body.prompt.slice(0, 400);
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
        `${truncatedPrompt}\r\n`
      );
    }
    
    // 終端
    parts.push(`--${boundary}--\r\n`);
    
    // Bufferを結合
    const bodyParts = parts.map(part => 
      typeof part === 'string' ? Buffer.from(part, 'utf-8') : part
    );
    const body = Buffer.concat(bodyParts);

    // HTTPSリクエストを送信
    const responseData = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.openai.com',
        port: 443,
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      };

      const request = https.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`JSON parse error: ${data}`));
            }
          } else {
            reject(new Error(`API error ${response.statusCode}: ${data}`));
          }
        });
      });

      request.on('error', reject);
      request.write(body);
      request.end();
    });

    console.log('[Proxy] Whisper success:', { 
      textLength: responseData.text?.length || 0,
      duration: responseData.duration 
    });
    
    res.json(responseData);
  } catch (error) {
    console.error('[Proxy] Whisper error:', error.message);
    res.status(500).json({ error: 'Whisper API request failed', details: error.message });
  }
});

// ===========================================
// Gemini API プロキシ（テキスト生成）
// ===========================================
app.post('/api/gemini', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error('[Proxy] Gemini API key not configured');
    return res.status(500).json({ error: 'Gemini API key not configured' });
  }

  const { prompt, temperature = 0.3, maxOutputTokens = 2048 } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'No prompt provided' });
  }

  console.log('[Proxy] Gemini request:', {
    promptLength: prompt.length,
    temperature,
    maxOutputTokens,
  });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature,
            maxOutputTokens,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Proxy] Gemini API error:', response.status, errorText);
      return res.status(response.status).json({ 
        error: `Gemini API error: ${response.status}`,
        details: errorText 
      });
    }

    const data = await response.json();
    console.log('[Proxy] Gemini success:', {
      hasContent: !!data.candidates?.[0]?.content,
    });
    
    res.json(data);
  } catch (error) {
    console.error('[Proxy] Gemini error:', error);
    res.status(500).json({ error: 'Gemini API request failed', details: String(error) });
  }
});

// ===========================================
// AssemblyAI トークン取得（既存）
// ===========================================
app.get('/api/assemblyai/token', async (req, res) => {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  
  if (!apiKey) {
    console.error('[Proxy] AssemblyAI API key not configured');
    return res.status(500).json({ error: 'AssemblyAI API key not configured' });
  }

  console.log('[Proxy] Requesting token from AssemblyAI v3 API...');

  try {
    const url = new URL('https://streaming.assemblyai.com/v3/token');
    url.searchParams.append('expires_in_seconds', '600');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Proxy] AssemblyAI token error:', response.status, errorText);
      return res.status(response.status).json({ error: `AssemblyAI error: ${response.status}`, details: errorText });
    }

    const data = await response.json();
    console.log('[Proxy] Token obtained successfully');
    res.json(data);
  } catch (error) {
    console.error('[Proxy] Token generation error:', error);
    res.status(500).json({ error: 'Failed to generate token', details: String(error) });
  }
});

// SPAのフォールバック
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log('API Keys configured:', {
    openai: !!process.env.OPENAI_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    assemblyai: !!process.env.ASSEMBLYAI_API_KEY,
  });
});
