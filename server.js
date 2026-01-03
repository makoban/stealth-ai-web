// ステルスAI APIプロキシサーバー v2.1
// Firebase認証 + PostgreSQLポイント管理対応
// ポイント消費: 0.25円 = 1pt
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const https = require('https');
const admin = require('firebase-admin');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

// ===========================================
// Firebase Admin SDK 初期化
// ===========================================
let firebaseInitialized = false;
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    : null;
  
  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseInitialized = true;
    console.log('[Firebase] Admin SDK initialized successfully');
  } else {
    console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT_KEY not configured - auth disabled');
  }
} catch (error) {
  console.error('[Firebase] Failed to initialize:', error.message);
}

// ===========================================
// PostgreSQL 接続プール
// ===========================================
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  console.log('[Database] PostgreSQL pool created');
} else {
  console.warn('[Database] DATABASE_URL not configured - database disabled');
}

// ===========================================
// ポイント消費設定
// 0.25円 = 1pt（販売価格: 1pt = 1円）
// ===========================================
const YEN_PER_POINT = 0.25; // 0.25円で1ポイント消費
const USD_TO_YEN = 150; // 為替レート（概算）

// API料金（USD）
const API_COSTS = {
  whisper: {
    perMinute: 0.006, // $0.006/分
  },
  gemini: {
    inputPerMillion: 0.075,  // $0.075/100万入力トークン
    outputPerMillion: 0.30,  // $0.30/100万出力トークン
  },
};

// コストからポイントを計算（0.25円 = 1pt）
function calculatePoints(costUsd) {
  const costYen = costUsd * USD_TO_YEN;
  const points = Math.ceil(costYen / YEN_PER_POINT);
  return Math.max(points, 1); // 最低1ポイント
}

// Whisperのポイント計算（音声の長さベース）
function calculateWhisperPoints(durationSeconds) {
  const durationMinutes = durationSeconds / 60;
  const costUsd = durationMinutes * API_COSTS.whisper.perMinute;
  return calculatePoints(costUsd);
}

// Geminiのポイント計算（トークン数ベース）
function calculateGeminiPoints(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1000000) * API_COSTS.gemini.inputPerMillion;
  const outputCost = (outputTokens / 1000000) * API_COSTS.gemini.outputPerMillion;
  return calculatePoints(inputCost + outputCost);
}

// トークン数を推定（日本語は1文字≒2トークン）
function estimateTokens(text) {
  const japaneseChars = (text.match(/[\u3000-\u9fff]/g) || []).length;
  const otherChars = text.length - japaneseChars;
  return Math.ceil(japaneseChars * 2 + otherChars * 0.25);
}

const INITIAL_POINTS = 500; // 新規ユーザーへの初期付与ポイント

// ===========================================
// 認証ミドルウェア
// ===========================================
const authenticateToken = async (req, res, next) => {
  // Firebase未設定の場合はスキップ（開発用）
  if (!firebaseInitialized) {
    req.user = null;
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('[Auth] Token verification failed:', error.message);
    req.user = null;
    next();
  }
};

// ===========================================
// ポイント管理関数
// ===========================================

// ユーザーを取得または作成
async function getOrCreateUser(firebaseUid, email, phoneNumber, displayName) {
  if (!pool) return null;
  
  try {
    // 既存ユーザーを検索
    const existingUser = await pool.query(
      'SELECT * FROM stealth_users WHERE firebase_uid = $1',
      [firebaseUid]
    );
    
    if (existingUser.rows.length > 0) {
      // 最終ログイン日時を更新
      await pool.query(
        'UPDATE stealth_users SET last_login_at = CURRENT_TIMESTAMP WHERE firebase_uid = $1',
        [firebaseUid]
      );
      return existingUser.rows[0];
    }
    
    // 新規ユーザー作成
    const newUser = await pool.query(
      `INSERT INTO stealth_users (firebase_uid, email, phone_number, display_name, points)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [firebaseUid, email, phoneNumber, displayName, INITIAL_POINTS]
    );
    
    // 初期ポイント付与履歴を記録
    await pool.query(
      `INSERT INTO stealth_point_history (user_id, change_amount, balance_after, reason, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [newUser.rows[0].id, INITIAL_POINTS, INITIAL_POINTS, 'initial_grant', '新規登録ボーナス']
    );
    
    console.log('[Database] New user created:', firebaseUid);
    return newUser.rows[0];
  } catch (error) {
    console.error('[Database] getOrCreateUser error:', error.message);
    return null;
  }
}

// ポイントを消費
async function consumePoints(userId, apiType, amount, description) {
  if (!pool) return { success: true, remaining: 999999 }; // DB未設定時は無制限
  
  try {
    // 現在のポイントを取得
    const user = await pool.query(
      'SELECT points FROM stealth_users WHERE id = $1',
      [userId]
    );
    
    if (user.rows.length === 0) {
      return { success: false, error: 'User not found' };
    }
    
    const currentPoints = user.rows[0].points;
    if (currentPoints < amount) {
      return { success: false, error: 'Insufficient points', remaining: currentPoints };
    }
    
    // ポイントを減算
    const newBalance = currentPoints - amount;
    await pool.query(
      'UPDATE stealth_users SET points = $1 WHERE id = $2',
      [newBalance, userId]
    );
    
    // 履歴を記録
    await pool.query(
      `INSERT INTO stealth_point_history (user_id, change_amount, balance_after, reason, api_type, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, -amount, newBalance, 'api_usage', apiType, description]
    );
    
    return { success: true, remaining: newBalance };
  } catch (error) {
    console.error('[Database] consumePoints error:', error.message);
    return { success: false, error: error.message };
  }
}

// API使用ログを記録
async function logApiUsage(userId, apiType, requestSize, responseSize, durationMs, pointsConsumed, success, errorMessage) {
  if (!pool || !userId) return;
  
  try {
    await pool.query(
      `INSERT INTO stealth_usage_logs 
       (user_id, api_type, request_size, response_size, duration_ms, points_consumed, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, apiType, requestSize, responseSize, durationMs, pointsConsumed, success, errorMessage]
    );
  } catch (error) {
    console.error('[Database] logApiUsage error:', error.message);
  }
}

// ===========================================
// ポイントチェックミドルウェア（事前チェック用）
// ===========================================
const checkUserAuth = async (req, res, next) => {
  // 認証されていない場合はスキップ（開発用）
  if (!req.user || !pool) {
    req.dbUser = null;
    return next();
  }
  
  try {
    // ユーザーを取得または作成
    const dbUser = await getOrCreateUser(
      req.user.uid,
      req.user.email,
      req.user.phone_number,
      req.user.name || req.user.email?.split('@')[0]
    );
    
    if (!dbUser) {
      return res.status(500).json({ error: 'Failed to get user data' });
    }
    
    req.dbUser = dbUser;
    next();
  } catch (error) {
    console.error('[Points] Check error:', error.message);
    res.status(500).json({ error: 'Points check failed' });
  }
};

// multer設定（音声ファイルアップロード用）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB制限
});

// CORS設定
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 認証ミドルウェアを全APIに適用
app.use('/api', authenticateToken);

// 静的ファイルの配信
app.use(express.static(path.join(__dirname, 'dist')));

// ヘルスチェック
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    firebase: firebaseInitialized,
    database: !!pool,
    pricing: {
      yenPerPoint: YEN_PER_POINT,
      usdToYen: USD_TO_YEN,
    },
  });
});

// ===========================================
// ユーザー情報API
// ===========================================
app.get('/api/user/me', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  if (!pool) {
    return res.json({
      uid: req.user.uid,
      email: req.user.email,
      points: 999999,
      message: 'Database not configured - unlimited mode',
    });
  }
  
  try {
    const dbUser = await getOrCreateUser(
      req.user.uid,
      req.user.email,
      req.user.phone_number,
      req.user.name || req.user.email?.split('@')[0]
    );
    
    res.json({
      uid: req.user.uid,
      email: req.user.email,
      displayName: dbUser.display_name,
      points: dbUser.points,
      createdAt: dbUser.created_at,
    });
  } catch (error) {
    console.error('[API] /user/me error:', error.message);
    res.status(500).json({ error: 'Failed to get user data' });
  }
});

// ポイント履歴API
app.get('/api/user/points/history', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  if (!pool) {
    return res.json({ history: [] });
  }
  
  try {
    const dbUser = await getOrCreateUser(req.user.uid, req.user.email, null, null);
    if (!dbUser) {
      return res.status(500).json({ error: 'Failed to get user' });
    }
    
    const history = await pool.query(
      `SELECT change_amount, balance_after, reason, api_type, description, created_at
       FROM stealth_point_history
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [dbUser.id]
    );
    
    res.json({ history: history.rows });
  } catch (error) {
    console.error('[API] /user/points/history error:', error.message);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// ===========================================
// Whisper API プロキシ（音声→テキスト変換）
// ポイント消費: 音声の長さに基づいて計算
// ===========================================
app.post('/api/whisper', upload.single('file'), checkUserAuth, async (req, res) => {
  const startTime = Date.now();
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
    user: req.user?.uid || 'anonymous',
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

    const duration = Date.now() - startTime;
    const audioDuration = responseData.duration || 0;
    
    // 音声の長さに基づいてポイントを計算
    const pointsToConsume = calculateWhisperPoints(audioDuration);
    
    console.log('[Proxy] Whisper success:', { 
      textLength: responseData.text?.length || 0,
      audioDuration,
      processingTime: duration,
      pointsToConsume,
    });
    
    // ポイント消費（認証済みユーザーのみ）
    if (req.dbUser) {
      // ポイント残高チェック
      if (req.dbUser.points < pointsToConsume) {
        return res.status(402).json({ 
          error: 'Insufficient points',
          required: pointsToConsume,
          remaining: req.dbUser.points,
        });
      }
      
      const description = `音声${audioDuration.toFixed(1)}秒`;
      const pointResult = await consumePoints(req.dbUser.id, 'whisper', pointsToConsume, description);
      if (!pointResult.success) {
        return res.status(402).json({ 
          error: pointResult.error,
          remaining: pointResult.remaining,
        });
      }
      
      // 使用ログを記録
      await logApiUsage(
        req.dbUser.id, 'whisper', req.file.size, 
        JSON.stringify(responseData).length, duration, 
        pointsToConsume, true, null
      );
    }
    
    // レスポンスにポイント残高を含める
    const response = { ...responseData };
    if (req.dbUser) {
      const user = await pool.query('SELECT points FROM stealth_users WHERE id = $1', [req.dbUser.id]);
      response._points = user.rows[0]?.points;
      response._pointsConsumed = pointsToConsume;
    }
    
    res.json(response);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('[Proxy] Whisper error:', error.message);
    
    // エラー時もログを記録
    if (req.dbUser) {
      await logApiUsage(
        req.dbUser.id, 'whisper', req.file?.size || 0, 
        0, duration, 0, false, error.message
      );
    }
    
    res.status(500).json({ error: 'Whisper API request failed', details: error.message });
  }
});

// ===========================================
// Gemini API プロキシ（テキスト生成）
// ポイント消費: トークン数に基づいて計算
// ===========================================
app.post('/api/gemini', checkUserAuth, async (req, res) => {
  const startTime = Date.now();
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error('[Proxy] Gemini API key not configured');
    return res.status(500).json({ error: 'Gemini API key not configured' });
  }

  const { prompt, temperature = 0.3, maxOutputTokens = 2048 } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'No prompt provided' });
  }

  // 入力トークン数を推定
  const inputTokens = estimateTokens(prompt);

  console.log('[Proxy] Gemini request:', {
    promptLength: prompt.length,
    inputTokens,
    temperature,
    maxOutputTokens,
    user: req.user?.uid || 'anonymous',
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
      
      if (req.dbUser) {
        await logApiUsage(
          req.dbUser.id, 'gemini', prompt.length, 
          0, Date.now() - startTime, 0, false, errorText
        );
      }
      
      return res.status(response.status).json({ 
        error: `Gemini API error: ${response.status}`,
        details: errorText 
      });
    }

    const data = await response.json();
    const duration = Date.now() - startTime;
    
    // 出力テキストを取得
    const outputText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const outputTokens = estimateTokens(outputText);
    
    // トークン数に基づいてポイントを計算
    const pointsToConsume = calculateGeminiPoints(inputTokens, outputTokens);
    
    console.log('[Proxy] Gemini success:', {
      hasContent: !!outputText,
      outputTokens,
      processingTime: duration,
      pointsToConsume,
    });
    
    // ポイント消費（認証済みユーザーのみ）
    if (req.dbUser) {
      // ポイント残高チェック
      if (req.dbUser.points < pointsToConsume) {
        return res.status(402).json({ 
          error: 'Insufficient points',
          required: pointsToConsume,
          remaining: req.dbUser.points,
        });
      }
      
      const description = `入力${inputTokens}tk/出力${outputTokens}tk`;
      const pointResult = await consumePoints(req.dbUser.id, 'gemini', pointsToConsume, description);
      if (!pointResult.success) {
        return res.status(402).json({ 
          error: pointResult.error,
          remaining: pointResult.remaining,
        });
      }
      
      // 使用ログを記録
      await logApiUsage(
        req.dbUser.id, 'gemini', prompt.length, 
        JSON.stringify(data).length, duration, 
        pointsToConsume, true, null
      );
    }
    
    // レスポンスにポイント残高を含める
    if (req.dbUser) {
      const user = await pool.query('SELECT points FROM stealth_users WHERE id = $1', [req.dbUser.id]);
      data._points = user.rows[0]?.points;
      data._pointsConsumed = pointsToConsume;
    }
    
    res.json(data);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('[Proxy] Gemini error:', error);
    
    if (req.dbUser) {
      await logApiUsage(
        req.dbUser.id, 'gemini', prompt?.length || 0, 
        0, duration, 0, false, String(error)
      );
    }
    
    res.status(500).json({ error: 'Gemini API request failed', details: String(error) });
  }
});

// ===========================================
// AssemblyAI トークン取得（既存）
// ===========================================
app.get('/api/assemblyai/token', checkUserAuth, async (req, res) => {
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
  console.log('Configuration:', {
    openai: !!process.env.OPENAI_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    assemblyai: !!process.env.ASSEMBLYAI_API_KEY,
    firebase: firebaseInitialized,
    database: !!pool,
  });
  console.log('Pricing:', {
    yenPerPoint: YEN_PER_POINT,
    usdToYen: USD_TO_YEN,
    whisperPerMinute: `$${API_COSTS.whisper.perMinute}`,
    geminiInput: `$${API_COSTS.gemini.inputPerMillion}/M tokens`,
    geminiOutput: `$${API_COSTS.gemini.outputPerMillion}/M tokens`,
  });
});
