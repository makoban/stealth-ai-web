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

// AssemblyAI トークン取得エンドポイント
app.get('/api/assemblyai/token', async (req, res) => {
  const apiKey = process.env.VITE_ASSEMBLYAI_API_KEY;
  
  if (!apiKey) {
    return res.status(500).json({ error: 'AssemblyAI API key not configured' });
  }

  try {
    const response = await fetch('https://api.assemblyai.com/v2/realtime/token', {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expires_in: 3600, // 1時間有効
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Proxy] AssemblyAI token error:', response.status, errorText);
      return res.status(response.status).json({ error: `AssemblyAI error: ${response.status}` });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('[Proxy] Token generation error:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// SPAのフォールバック
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
