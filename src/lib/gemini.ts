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
  context?: string;      // 会話の状況予想（例：会議、雑談、講義など）
  participants?: string; // 参加者の予想（例：上司と部下、友人同士など）
  purpose?: string;      // 会話の目的予想（例：情報共有、意思決定など）
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
  knowledgeLevel: KnowledgeLevel,
  apiKey: string
): Promise<ProperNoun[]> {
  // 知識レベルに応じた検出基準
  const levelCriteria = {
    elementary: '小学生が知らない可能性が高い単語を抽出してください。小学校の教科書に出てこないような専門用語、企業名、人名、地名など',
    middle: '中学生が知らない可能性がある単語を抽出してください。中学の教科書に出てこないような専門用語や固有名詞',
    high: '高校生が知らない可能性がある単語を抽出してください。高校の教科書を超える専門用語や固有名詞',
    university: '大学生が知らない可能性がある単語を抽出してください。専門分野の用語や最新の固有名詞',
    expert: '専門家でも確認が必要な可能性がある単語のみ抽出してください。非常に専門的な用語や最新の固有名詞',
  };

  const prompt = `以下のテキストから固有名詞（人名、地名、組織名、製品名、作品名、専門用語など）を抽出してください。

重要: ${levelCriteria[knowledgeLevel]}

テキスト: "${text}"

JSON形式で回答してください:
[{"word": "固有名詞", "category": "カテゴリ", "confidence": 0.9}]

該当する単語がない場合は空の配列[]を返してください。`;

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

また、会話の状況を予想してください：
- これは何の場面か（会議、雑談、講義、商談、インタビューなど）
- 誰が話しているか（上司と部下、友人同士、先生と生徒、営業と顧客など）
- 会話の目的は何か（情報共有、意思決定、問題解決、アイデア出しなど）

JSON形式で回答してください:
{"summary": "要約（50文字以内）", "topics": ["トピック1", "トピック2"], "keyPoints": ["ポイント1", "ポイント2"], "context": "会話の場面", "participants": "参加者の予想", "purpose": "会話の目的"}`;

  try {
    const response = await callGemini(fullPrompt, apiKey);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { summary: '', topics: [], keyPoints: [], context: '', participants: '', purpose: '' };
  } catch {
    return { summary: '', topics: [], keyPoints: [], context: '', participants: '', purpose: '' };
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

// 会話ジャンルの型
export interface ConversationGenre {
  primary: string;           // 主要ジャンル
  secondary: string[];       // 副次的ジャンル
  confidence: number;        // 確信度
  keywords: string[];        // 検出されたキーワード
  context: string;           // ジャンルに基づくコンテキスト説明
}

// ジャンル一覧
export const GENRE_LIST = [
  'ビジネス・仕事',
  'テクノロジー・IT',
  '食べ物・グルメ',
  'スポーツ',
  '音楽・エンタメ',
  '映画・ドラマ',
  'ゲーム',
  '旅行・観光',
  '健康・医療',
  '教育・学習',
  '政治・経済',
  '科学・研究',
  'ファッション',
  '趣味・ホビー',
  '日常会話',
  'その他',
] as const;

export type GenreType = typeof GENRE_LIST[number];

// 会話からジャンルを推定
export async function detectConversationGenre(
  conversation: string,
  previousGenres: string[] | null,
  apiKey: string
): Promise<ConversationGenre> {
  const genreListStr = GENRE_LIST.join('、');
  
  const prompt = previousGenres && previousGenres.length > 0
    ? `前回推定されたジャンル: ${previousGenres.join('、')}

新しい会話内容: "${conversation}"

前回のジャンル推定を踏まえて、この会話のジャンルを再評価してください。`
    : `会話内容: "${conversation}"

この会話のジャンルを推定してください。`;

  const fullPrompt = `${prompt}

以下のジャンルから最も適切なものを選んでください（複数可）:
${genreListStr}

重要:
- 会話の中で言及されている具体的なキーワードを抽出してください
- 例えば「ラーメン」「寿司」などの単語があれば「食べ物・グルメ」
- 「会議」「プロジェクト」などがあれば「ビジネス・仕事」
- 複数のジャンルにまたがる場合は、主要ジャンルと副次的ジャンルを分けてください

JSON形式で回答してください:
{"primary": "主要ジャンル", "secondary": ["副次的ジャンル1", "副次的ジャンル2"], "confidence": 0.8, "keywords": ["検出キーワード1", "検出キーワード2"], "context": "このジャンルに基づく会話の解釈（30文字以内）"}

会話が短すぎてジャンル判定が難しい場合:
{"primary": "日常会話", "secondary": [], "confidence": 0.3, "keywords": [], "context": "ジャンル判定には情報が不足"}`;

  try {
    const response = await callGemini(fullPrompt, apiKey);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      // ジャンルが有効なものか確認
      if (!GENRE_LIST.includes(result.primary)) {
        result.primary = '日常会話';
      }
      result.secondary = (result.secondary || []).filter((g: string) => GENRE_LIST.includes(g as GenreType));
      return result;
    }
    return { primary: '日常会話', secondary: [], confidence: 0.3, keywords: [], context: 'ジャンル判定失敗' };
  } catch {
    return { primary: '日常会話', secondary: [], confidence: 0.3, keywords: [], context: 'ジャンル判定エラー' };
  }
}

// ジャンルコンテキストを含めた固有名詞検出
export async function detectProperNounsWithGenre(
  text: string,
  knowledgeLevel: KnowledgeLevel,
  genre: ConversationGenre | null,
  apiKey: string
): Promise<ProperNoun[]> {
  const levelCriteria = {
    elementary: '小学生が知らない可能性が高い単語を抽出してください。小学校の教科書に出てこないような専門用語、企業名、人名、地名など',
    middle: '中学生が知らない可能性がある単語を抽出してください。中学の教科書に出てこないような専門用語や固有名詞',
    high: '高校生が知らない可能性がある単語を抽出してください。高校の教科書を超える専門用語や固有名詞',
    university: '大学生が知らない可能性がある単語を抽出してください。専門分野の用語や最新の固有名詞',
    expert: '専門家でも確認が必要な可能性がある単語のみ抽出してください。非常に専門的な用語や最新の固有名詞',
  };

  const genreContext = genre && genre.confidence > 0.5
    ? `
会話のジャンル: ${genre.primary}${genre.secondary.length > 0 ? `（関連: ${genre.secondary.join('、')}）` : ''}
検出されたキーワード: ${genre.keywords.join('、')}
コンテキスト: ${genre.context}

このジャンルの文脈を考慮して、固有名詞を抽出してください。
例えば「食べ物・グルメ」ジャンルなら、店名、料理名、食材名などに注目してください。
「テクノロジー・IT」ジャンルなら、サービス名、技術用語、企業名などに注目してください。`
    : '';

  const prompt = `以下のテキストから固有名詞（人名、地名、組織名、製品名、作品名、専門用語など）を抽出してください。

重要: ${levelCriteria[knowledgeLevel]}
${genreContext}

テキスト: "${text}"

JSON形式で回答してください:
[{"word": "固有名詞", "category": "カテゴリ", "confidence": 0.9}]

該当する単語がない場合は空の配列[]を返してください。`;

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

// ジャンルコンテキストを含めた会話修正
export async function correctConversationWithGenre(
  text: string,
  context: string,
  genre: ConversationGenre | null,
  apiKey: string
): Promise<CorrectedConversation> {
  const genreContext = genre && genre.confidence > 0.5
    ? `
会話のジャンル: ${genre.primary}
このジャンルでよく使われる用語や固有名詞を考慮して修正してください。
例えば「食べ物・グルメ」ジャンルなら「らーめん」→「ラーメン」、「すし」→「寿司」など。
「テクノロジー・IT」ジャンルなら「あいふぉん」→「iPhone」、「ぐーぐる」→「Google」など。`
    : '';

  const prompt = `音声認識で取得した以下のテキストを、前後の文脈から誤認識を修正してください。

テキスト: "${text}"
前後の文脈: "${context}"
${genreContext}

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
