// Gemini APIキー（環境変数またはデフォルト値）
export const HARDCODED_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';

// 知識レベルの型
export type KnowledgeLevel = 'elementary' | 'middle' | 'high' | 'university' | 'expert';

// 知識レベルの説明
export const KNOWLEDGE_LEVEL_LABELS: Record<KnowledgeLevel, string> = {
  elementary: '小学生',
  middle: '中学生',
  high: '高校生',
  university: '大学生',
  expert: '専門家',
};

// API使用量の追跡
let apiUsageStats = {
  callCount: 0,
  inputTokens: 0,
  outputTokens: 0,
};

// Whisper API使用量の追跡
let whisperUsageStats = {
  callCount: 0,
  totalDurationSeconds: 0,
};

export interface ApiUsageStats {
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface WhisperUsageStats {
  callCount: number;
  totalDurationSeconds: number;
  estimatedCost: number;
}

export interface TotalApiUsageStats {
  gemini: ApiUsageStats;
  whisper: WhisperUsageStats;
  totalCost: number;
}

// トークン数を推定（日本語は1文字≒2トークン）
const estimateTokens = (text: string): number => {
  const japaneseChars = (text.match(/[\u3000-\u9fff]/g) || []).length;
  const otherChars = text.length - japaneseChars;
  return Math.ceil(japaneseChars * 2 + otherChars * 0.25);
};

export const getApiUsageStats = (): ApiUsageStats => {
  const inputCost = (apiUsageStats.inputTokens / 1000000) * 0.075;
  const outputCost = (apiUsageStats.outputTokens / 1000000) * 0.30;
  return {
    ...apiUsageStats,
    estimatedCost: inputCost + outputCost,
  };
};

export const getWhisperUsageStats = (): WhisperUsageStats => {
  const costPerMinute = 0.006;
  const totalMinutes = whisperUsageStats.totalDurationSeconds / 60;
  return {
    ...whisperUsageStats,
    estimatedCost: totalMinutes * costPerMinute,
  };
};

export const getTotalApiUsageStats = (): TotalApiUsageStats => {
  const gemini = getApiUsageStats();
  const whisper = getWhisperUsageStats();
  return {
    gemini,
    whisper,
    totalCost: gemini.estimatedCost + whisper.estimatedCost,
  };
};

export const addWhisperUsage = (durationSeconds: number): void => {
  whisperUsageStats.callCount++;
  whisperUsageStats.totalDurationSeconds += durationSeconds;
};

export const resetApiUsageStats = (): void => {
  apiUsageStats = { callCount: 0, inputTokens: 0, outputTokens: 0 };
};

export const resetWhisperUsageStats = (): void => {
  whisperUsageStats = { callCount: 0, totalDurationSeconds: 0 };
};

export const resetAllUsageStats = (): void => {
  resetApiUsageStats();
  resetWhisperUsageStats();
};

// 固有名詞の型
export interface ProperNoun {
  word: string;
  category: string;
  confidence: number;
}

// 候補の型
export interface Candidate {
  name: string;
  description: string;
  confidence: number;
  url?: string;
}

// 会話要約の型
export interface ConversationSummary {
  summary: string;
  topics: string[];
  keyPoints: string[];
}

// 修正された会話の型
export interface CorrectedConversation {
  correctedText: string;
  uncertainWords: string[];
  wasModified: boolean;
}

// Gemini APIを呼び出す共通関数
async function callGemini(prompt: string, apiKey: string): Promise<string> {
  console.log('[Gemini] callGemini called, apiKey:', apiKey ? apiKey.substring(0, 10) + '...' : 'MISSING');
  const inputTokens = estimateTokens(prompt);
  apiUsageStats.inputTokens += inputTokens;
  apiUsageStats.callCount++;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Gemini] API error:', response.status, errorText);
    throw new Error(`API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  
  const outputTokens = estimateTokens(text);
  apiUsageStats.outputTokens += outputTokens;

  return text;
}

// 固有名詞を検出
export async function detectProperNouns(
  text: string,
  apiKey: string
): Promise<ProperNoun[]> {
  const prompt = `以下のテキストから固有名詞（人名、地名、組織名、製品名、作品名など）を抽出してください。
一般的な名詞や動詞は含めないでください。

テキスト: "${text}"

JSON形式で回答してください:
[{"word": "固有名詞", "category": "カテゴリ", "confidence": 0.9}]

固有名詞がない場合は空の配列[]を返してください。`;

  try {
    const response = await callGemini(prompt, apiKey);
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch {
    return [];
  }
}

// 固有名詞の説明を取得
export async function explainProperNoun(
  word: string,
  category: string,
  context: string,
  knowledgeLevel: KnowledgeLevel,
  apiKey: string
): Promise<Candidate[]> {
  const levelPrompt = {
    elementary: '小学生でもわかるように、簡単な言葉で',
    middle: '中学生向けに、基本的な用語を使って',
    high: '高校生向けに、やや専門的な内容も含めて',
    university: '大学生向けに、専門的な内容を含めて',
    expert: '専門家向けに、詳細かつ正確に',
  };

  const prompt = `「${word}」（${category}）について、${levelPrompt[knowledgeLevel]}説明してください。

文脈: "${context}"

この文脈で最も適切な解釈を1〜3個、JSON形式で回答してください。
参考URLはWikipediaや公式サイトなど信頼できるソースを優先してください。
[{"name": "正式名称", "description": "説明（100文字以内）", "confidence": 0.9, "url": "参考URL"}]`;

  try {
    const response = await callGemini(prompt, apiKey);
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch {
    return [];
  }
}

// 会話を要約
export async function summarizeConversation(
  conversation: string,
  previousSummary: string | null,
  apiKey: string
): Promise<ConversationSummary> {
  console.log('[Gemini] summarizeConversation called, conversation length:', conversation.length);
  const prompt = previousSummary
    ? `前回の要約: "${previousSummary}"

新しい会話内容: "${conversation}"

前回の要約を踏まえて、会話全体を要約してください。`
    : `会話内容: "${conversation}"

この会話を要約してください。`;

  const fullPrompt = `${prompt}

JSON形式で回答してください:
{"summary": "要約（50文字以内）", "topics": ["トピック1", "トピック2"], "keyPoints": ["ポイント1", "ポイント2"]}`;

  try {
    const response = await callGemini(fullPrompt, apiKey);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { summary: '', topics: [], keyPoints: [] };
  } catch {
    return { summary: '', topics: [], keyPoints: [] };
  }
}

// 会話を修正
export async function correctConversation(
  text: string,
  context: string,
  apiKey: string
): Promise<CorrectedConversation> {
  const prompt = `音声認識で取得した以下のテキストを、前後の文脈から誤認識を修正してください。

テキスト: "${text}"
前後の文脈: "${context}"

修正が必要な場合は修正し、不確かな単語には「？」を付けてください。

JSON形式で回答してください:
{"correctedText": "修正後のテキスト", "uncertainWords": ["不確かな単語1", "不確かな単語2"], "wasModified": true}

修正不要の場合:
{"correctedText": "${text}", "uncertainWords": [], "wasModified": false}`;

  try {
    const response = await callGemini(prompt, apiKey);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { correctedText: text, uncertainWords: [], wasModified: false };
  } catch {
    return { correctedText: text, uncertainWords: [], wasModified: false };
  }
}
