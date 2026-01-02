// AssemblyAI トークン取得プロキシサーバー
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS設定
app.use(cors());
app.use(express.json());

// 静的ファイルの配信
app.use(express.static(path.join(__dirname, 'dist')));

// AssemblyAI トークン取得エンドポイント（v3 API使用）
app.get('/api/assemblyai/token', async (req, res) => {
  const apiKey = process.env.VITE_ASSEMBLYAI_API_KEY;
  
  if (!apiKey) {
    console.error('[Proxy] AssemblyAI API key not configured');
    return res.status(500).json({ error: 'AssemblyAI API key not configured' });
  }

  console.log('[Proxy] Requesting token from AssemblyAI v3 API...');

  try {
    // v3 APIはGETメソッドでクエリパラメータを使用
    const url = new URL('https://streaming.assemblyai.com/v3/token');
    url.searchParams.append('expires_in_seconds', '600'); // 10分有効

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
});
