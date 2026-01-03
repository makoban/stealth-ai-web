// Gemini APIキー（環境変数またはデフォルト値）
// APIキーはサーバー側で管理（フロントには露出しない）

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
  possibleInterpretations?: string[];  // 複数の解釈候補
  needsVerification?: boolean;         // 要確認フラグ
}

// 候補の型
export interface Candidate {
  name: string;
  description: string;
  confidence: number;
  url?: string;
  alternativeNames?: string[];  // 別名・略称
}

// 拡張固有名詞検出結果の型
export interface ExtendedProperNounResult {
  confirmed: ProperNoun[];      // 確実な固有名詞
  candidates: ProperNoun[];     // 候補（要確認）
  possibleNames: ProperNoun[];  // 人名の可能性
  possiblePlaces: ProperNoun[]; // 地名の可能性
  possibleOrgs: ProperNoun[];   // 組織名の可能性
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

// リアルタイム整形結果の型
export interface RealtimeCorrectionResult {
  correctedText: string;
  originalText: string;
  wasModified: boolean;
  detectedProperNouns: string[];  // 検出された固有名詞
  confidence: number;
}

// Gemini APIをサーバー経由で呼び出す共通関数
async function callGemini(prompt: string): Promise<string> {
  console.log('[Gemini] callGemini called via server proxy');
  const inputTokens = estimateTokens(prompt);
  apiUsageStats.inputTokens += inputTokens;
  apiUsageStats.callCount++;

  // サーバー経由でAPIを呼び出し（APIキーはサーバー側で管理）
  const response = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      temperature: 0.3,
      maxOutputTokens: 2048,
    }),
  });

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

// リアルタイム日本語整形（Whisper出力を即座に整形）
export async function correctRealtimeText(
  rawText: string,
  conversationContext: string,
  genre: ConversationGenre | null,
): Promise<RealtimeCorrectionResult> {
  console.log('[Gemini] correctRealtimeText called:', rawText);
  
  const genreContext = genre && genre.confidence > 0.5
    ? `
【会話のジャンル】: ${genre.primary}${genre.secondary.length > 0 ? `（関連: ${genre.secondary.join('、')}）` : ''}
キーワード: ${genre.keywords.join('、')}
このジャンルでよく使われる用語を考慮してください。`
    : '';

  const contextHint = conversationContext && conversationContext.length > 0
    ? `
【これまでの会話】:
"${conversationContext.slice(-500)}"
`
    : '';

  const prompt = `音声認識（Whisper）で取得した以下のテキストを、正確な日本語に整形してください。

【入力テキスト】: "${rawText}"
${contextHint}
${genreContext}

【整形ルール】
1. **誤認識の修正**: 音声認識の誤りを文脈から推測して修正
   - 例: 「あいふぉん」→「iPhone」、「ぐーぐる」→「Google」
   - 例: 「きょうと」→「京都」（地名の場合）
   - 例: 「たなかさん」→「田中さん」

2. **固有名詞の正規化**: 
   - 人名、地名、会社名、製品名などを正しい表記に
   - カタカナ語は適切な表記に（英語表記が一般的なら英語に）

3. **文法の修正**:
   - 助詞の誤りを修正
   - 不自然な言い回しを自然に

4. **固有名詞の検出**:
   - 整形後のテキストから固有名詞を抽出

【重要】
- 意味を変えないこと
- 過度な修正はしないこと
- 不確かな修正は避けること

JSON形式で回答してください:
{
  "correctedText": "整形後のテキスト",
  "wasModified": true,
  "detectedProperNouns": ["固有名詞1", "固有名詞2"],
  "confidence": 0.9
}

修正不要の場合:
{
  "correctedText": "${rawText}",
  "wasModified": false,
  "detectedProperNouns": [],
  "confidence": 1.0
}`;

  try {
    const response = await callGemini(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        correctedText: result.correctedText || rawText,
        originalText: rawText,
        wasModified: result.wasModified || false,
        detectedProperNouns: result.detectedProperNouns || [],
        confidence: result.confidence || 0.8,
      };
    }
    return {
      correctedText: rawText,
      originalText: rawText,
      wasModified: false,
      detectedProperNouns: [],
      confidence: 1.0,
    };
  } catch (e) {
    console.error('[Gemini] correctRealtimeText error:', e);
    return {
      correctedText: rawText,
      originalText: rawText,
      wasModified: false,
      detectedProperNouns: [],
      confidence: 1.0,
    };
  }
}

// 固有名詞を検出
export async function detectProperNouns(
  text: string,
  knowledgeLevel: KnowledgeLevel,
): Promise<ProperNoun[]> {
  // 知識レベルに応じた検出基準
  // 注意: これは「柔軟度」ではなく「知識として知らないレベル」を設定するもの
  // 小学生レベル = 小学生の知識で知らない単語を調べる
  // 専門家レベル = 専門家でも知らないような最先端・ニッチな用語のみ調べる
  const levelCriteria = {
    elementary: '小学生の知識レベルで知らない単語を抽出してください。小学校で習わない単語、専門用語、企業名、人名、地名、カタカナ語など、小学生が意味を知らないと思われる単語すべて',
    middle: '中学生の知識レベルで知らない単語を抽出してください。中学校の教科書に出てこない専門用語、固有名詞、業界用語など',
    high: '高校生の知識レベルで知らない単語を抽出してください。高校の教科書や一般常識を超える専門用語、業界固有の用語、最新のトレンド用語など',
    university: '大学生の知識レベルで知らない単語を抽出してください。大学の一般教養を超える高度な専門用語、特定分野の専門知識が必要な用語',
    expert: 'その分野の専門家でも知らない可能性がある単語のみ抽出してください。最先端の研究用語、非常にニッチな専門用語、最新の業界動向に関する用語など、専門家でも調べる必要があるレベルの単語のみ',
  };

  const prompt = `以下のテキストから固有名詞（人名、地名、組織名、製品名、作品名、専門用語など）を抽出してください。

重要: ${levelCriteria[knowledgeLevel]}

テキスト: "${text}"

JSON形式で回答してください:
[{"word": "固有名詞", "category": "カテゴリ", "confidence": 0.9}]

該当する単語がない場合は空の配列[]を返してください。`;

  try {
    const response = await callGemini(prompt);
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
    const response = await callGemini(prompt);
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
    const response = await callGemini(fullPrompt);
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
    const response = await callGemini(prompt);
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
): Promise<ConversationGenre> {
  const genreListStr = GENRE_LIST.join('、');
  
  const prompt = previousGenres && previousGenres.length > 0
    ? `前回のジャンル推定: ${previousGenres.join('、')}

新しい会話内容: "${conversation}"

前回の推定を踏まえて、会話のジャンルを再推定してください。`
    : `会話内容: "${conversation}"

この会話のジャンルを推定してください。`;

  const fullPrompt = `${prompt}

【ジャンル一覧】
${genreListStr}

【指示】
1. 最も適切な主要ジャンルを1つ選んでください
2. 関連する副次的ジャンルを0〜2個選んでください
3. ジャンル判定の根拠となるキーワードを抽出してください
4. このジャンルに基づく会話のコンテキストを説明してください

JSON形式で回答してください:
{
  "primary": "主要ジャンル",
  "secondary": ["副次的ジャンル1", "副次的ジャンル2"],
  "confidence": 0.8,
  "keywords": ["キーワード1", "キーワード2"],
  "context": "このジャンルに基づくコンテキスト説明"
}`;

  try {
    const response = await callGemini(fullPrompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      // ジャンルの検証
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
): Promise<ProperNoun[]> {
  // 知識レベルに応じた検出基準（「知識として知らないレベル」を設定）
  const levelCriteria = {
    elementary: '小学生の知識レベルで知らない単語を抽出してください。小学校で習わない単語、専門用語、企業名、人名、地名、カタカナ語など、小学生が意味を知らないと思われる単語すべて',
    middle: '中学生の知識レベルで知らない単語を抽出してください。中学校の教科書に出てこない専門用語、固有名詞、業界用語など',
    high: '高校生の知識レベルで知らない単語を抽出してください。高校の教科書や一般常識を超える専門用語、業界固有の用語、最新のトレンド用語など',
    university: '大学生の知識レベルで知らない単語を抽出してください。大学の一般教養を超える高度な専門用語、特定分野の専門知識が必要な用語',
    expert: 'その分野の専門家でも知らない可能性がある単語のみ抽出してください。最先端の研究用語、非常にニッチな専門用語、最新の業界動向に関する用語など、専門家でも調べる必要があるレベルの単語のみ',
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
    const response = await callGemini(prompt);
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
  
  userHint?: string
): Promise<CorrectedConversation> {
  const genreContext = genre && genre.confidence > 0.5
    ? `
会話のジャンル: ${genre.primary}
このジャンルでよく使われる用語や固有名詞を考慮して修正してください。
例えば「食べ物・グルメ」ジャンルなら「らーめん」→「ラーメン」、「すし」→「寿司」など。
「テクノロジー・IT」ジャンルなら「あいふぉん」→「iPhone」、「ぐーぐる」→「Google」など。`
    : '';

  const userHintContext = userHint && userHint.trim()
    ? `
【ユーザーからのヒント】
${userHint.trim()}
上記のヒントを参考に、固有名詞や専門用語の正しい表記を推測してください。`
    : '';

  const prompt = `音声認識で取得した以下のテキストを、前後の文脈から誤認識を修正してください。

テキスト: "${text}"
前後の文脈: "${context}"
${genreContext}${userHintContext}

修正が必要な場合は修正し、不確かな単語には「？」を付けてください。

JSON形式で回答してください:
{"correctedText": "修正後のテキスト", "uncertainWords": ["不確かな単語1", "不確かな単語2"], "wasModified": true}

修正不要の場合:
{"correctedText": "${text}", "uncertainWords": [], "wasModified": false}`;

  try {
    const response = await callGemini(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { correctedText: text, uncertainWords: [], wasModified: false };
  } catch {
    return { correctedText: text, uncertainWords: [], wasModified: false };
  }
}


// 拡張固有名詞検出 - 候補を含む幅広い検出
export async function detectProperNounsExtended(
  text: string,
  knowledgeLevel: KnowledgeLevel,
  genre: ConversationGenre | null,
  conversationContext: string,
): Promise<ExtendedProperNounResult> {
  // 知識レベルに応じた検出基準（「知識として知らないレベル」を設定）
  const levelCriteria = {
    elementary: '小学生の知識で知らない単語のみを抽出。小学校で習う一般的な地名（東京、大阪、沖縄、ハワイ等）や有名な固有名詞は除外',
    middle: '中学生の知識で知らない単語のみを抽出。中学校で習う地理・歴史の知識は除外',
    high: '高校生の知識で知らない単語のみを抽出。高校で習う一般教養は除外',
    university: '大学生の知識で知らない単語のみを抽出。一般的な地名・国名・有名企業名は除外',
    expert: '専門家でも知らない可能性がある単語のみを抽出。一般的な地名（東京、大阪、沖縄、ハワイ、ニューヨーク等）、有名企業（Google、Apple、トヨタ等）、有名人物は完全に除外。最先端の専門用語、ニッチな固有名詞のみ',
  };

  // 知識レベルに応じた除外例
  const levelExclusions = {
    elementary: '※以下は除外: 都道府県名、主要国名、有名観光地（沖縄、ハワイ、ディズニー等）',
    middle: '※以下は除外: 世界の主要都市、有名観光地、主要企業名',
    high: '※以下は除外: 一般的な地名・国名、有名企業、有名人物',
    university: '※以下は除外: 一般教養で知っているべき固有名詞全般',
    expert: '※以下は完全に除外: 一般的な地名（東京、大阪、京都、沖縄、北海道、ハワイ、グアム、ニューヨーク、ロンドン、パリ等）、有名企業（Google、Apple、Microsoft、Amazon、トヨタ、ソニー等）、有名人物、一般的な専門用語。本当に専門家でも知らないようなニッチな用語のみ抽出すること',
  };

  const genreHints = genre && genre.confidence > 0.5
    ? `
会話のジャンル: ${genre.primary}${genre.secondary.length > 0 ? `（関連: ${genre.secondary.join('、')}）` : ''}
このジャンルでよく出てくる固有名詞に注目してください。`
    : '';

  const prompt = `以下のテキストから、固有名詞とその候補を抽出してください。

テキスト: "${text}"
会話の文脈: "${conversationContext}"
${genreHints}

【最重要: 知識レベルに応じた抽出】
${levelCriteria[knowledgeLevel]}
${levelExclusions[knowledgeLevel]}

【抽出カテゴリ】
1. **確実な固有名詞**: 明らかに固有名詞で、上記知識レベルで知らないもの
2. **候補（要確認）**: 固有名詞かもしれないが確信が持てないもの
3. **人名の可能性**: 人の名前かもしれない単語（姓、名、ニックネーム含む）
4. **地名の可能性**: 場所の名前かもしれない単語（店名、施設名含む）
5. **組織名の可能性**: 会社、団体、サービス名かもしれない単語

【検出のポイント】
- カタカナ語は特に注目（外来語、ブランド名の可能性）
- 「〜さん」「〜くん」の前の単語は人名の可能性
- 「〜に行く」「〜で食べる」の前の単語は地名・店名の可能性
- 「〜で働いている」「〜の」の前の単語は組織名の可能性

【カテゴリ】
人名、地名、店名、会社名、サービス名、製品名、作品名、専門用語、その他

JSON形式で回答してください:
{
  "confirmed": [{"word": "確実な固有名詞", "category": "カテゴリ", "confidence": 0.9}],
  "candidates": [{"word": "候補", "category": "カテゴリ", "confidence": 0.6, "possibleInterpretations": ["解釈1", "解釈2"], "needsVerification": true}],
  "possibleNames": [{"word": "人名候補", "category": "人名", "confidence": 0.5, "possibleInterpretations": ["姓かも", "名かも"]}],
  "possiblePlaces": [{"word": "地名候補", "category": "地名", "confidence": 0.5}],
  "possibleOrgs": [{"word": "組織名候補", "category": "会社名", "confidence": 0.5}]
}

該当がない場合は空の配列を使用してください。`;

  try {
    const response = await callGemini(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        confirmed: result.confirmed || [],
        candidates: result.candidates || [],
        possibleNames: result.possibleNames || [],
        possiblePlaces: result.possiblePlaces || [],
        possibleOrgs: result.possibleOrgs || [],
      };
    }
    return { confirmed: [], candidates: [], possibleNames: [], possiblePlaces: [], possibleOrgs: [] };
  } catch {
    return { confirmed: [], candidates: [], possibleNames: [], possiblePlaces: [], possibleOrgs: [] };
  }
}

// 固有名詞の詳細調査 - 複数の候補を返す
export async function investigateProperNoun(
  word: string,
  category: string,
  context: string,
  genre: ConversationGenre | null,
  knowledgeLevel: KnowledgeLevel,
): Promise<Candidate[]> {
  const levelPrompt = {
    elementary: '小学生でもわかるように、簡単な言葉で',
    middle: '中学生向けに、基本的な用語を使って',
    high: '高校生向けに、やや専門的な内容も含めて',
    university: '大学生向けに、専門的な内容を含めて',
    expert: '専門家向けに、詳細かつ正確に',
  };

  const genreHint = genre && genre.confidence > 0.5
    ? `会話のジャンル「${genre.primary}」を考慮してください。`
    : '';

  const prompt = `「${word}」について調査してください。

カテゴリ: ${category}
文脈: "${context}"
${genreHint}

【重要な指示】
1. この単語が何を指している可能性があるか、**複数の候補**を挙げてください
2. 最も可能性が高いものから順に並べてください
3. 同音異義語、略称、愛称なども考慮してください
4. 各候補について${levelPrompt[knowledgeLevel]}説明してください

【例】
- 「田中」→ 田中角栄（政治家）、田中将大（野球選手）、一般的な姓
- 「アップル」→ Apple Inc.（IT企業）、りんご、アップルパイ
- 「渋谷」→ 渋谷区（東京都）、渋谷駅、渋谷という姓

JSON形式で回答してください（最大5候補）:
[
  {"name": "正式名称1", "description": "説明（80文字以内）", "confidence": 0.9, "url": "参考URL", "alternativeNames": ["別名", "略称"]},
  {"name": "正式名称2", "description": "説明（80文字以内）", "confidence": 0.7, "url": "参考URL"}
]

該当がない場合は空の配列[]を返してください。`;

  try {
    const response = await callGemini(prompt);
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch {
    return [];
  }
}

// 会話全体から固有名詞を再検出（見逃し防止）
export async function redetectMissedProperNouns(
  fullConversation: string,
  alreadyDetected: string[],
  genre: ConversationGenre | null,
): Promise<ProperNoun[]> {
  const alreadyDetectedStr = alreadyDetected.length > 0
    ? `既に検出済み: ${alreadyDetected.join('、')}`
    : '';

  const genreHint = genre && genre.confidence > 0.5
    ? `会話のジャンル: ${genre.primary}`
    : '';

  const prompt = `以下の会話全体を見直して、見逃している可能性のある固有名詞を探してください。

会話: "${fullConversation}"
${alreadyDetectedStr}
${genreHint}

【重要な指示】
1. 既に検出済みの単語は除外してください
2. 以下のパターンに注目してください：
   - 「〜さん」「〜くん」「〜ちゃん」の前の単語（人名）
   - 「〜に行った」「〜で」の前の単語（地名・店名）
   - 「〜で働いている」「〜の社員」の前の単語（会社名）
   - カタカナ語（ブランド名、サービス名の可能性）
   - 漢字2〜4文字の連続（人名、地名の可能性）
3. 曖昧でも候補として挙げてください

JSON形式で回答してください:
[{"word": "見逃していた固有名詞", "category": "カテゴリ", "confidence": 0.6, "needsVerification": true}]

見逃しがない場合は空の配列[]を返してください。`;

  try {
    const response = await callGemini(prompt);
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch {
    return [];
  }
}


// ジャンル別の固有名詞・専門用語を生成（Whisperプロンプト用）
export async function generateGenreKeywords(
  genre: ConversationGenre,
  teachContent: string,
  detectedNouns: string[],
): Promise<string> {
  // 教えるファイルの内容から固有名詞を抽出
  const teachHint = teachContent && teachContent.trim()
    ? `
【ユーザーが教えた情報】:
${teachContent.slice(0, 300)}

この情報に含まれる固有名詞（人名、地名、組織名、専門用語など）を優先的に含めてください。`
    : '';

  // 既に検出された固有名詞
  const detectedHint = detectedNouns.length > 0
    ? `
【会話で既に検出された固有名詞】:
${detectedNouns.slice(0, 20).join('、')}

これらの固有名詞も含めてください。`
    : '';

  const prompt = `音声認識（Whisper API）の精度向上のため、以下のジャンルでよく使われる固有名詞・専門用語のリストを生成してください。

【ジャンル】: ${genre.primary}${genre.secondary.length > 0 ? `（関連: ${genre.secondary.join('、')}）` : ''}
【キーワード】: ${genre.keywords.join('、')}
${teachHint}
${detectedHint}

【生成ルール】
1. そのジャンルで頻出する固有名詞を20〜30個程度
2. 人名、地名、組織名、製品名、専門用語をバランスよく
3. 音声認識で間違いやすい単語を優先（例: 同志社→どうしても、慶應→けいおう）
4. カンマ区切りの単純なリストで出力
5. 説明は不要、単語のみ

【出力例】
同志社大学、慶應義塾大学、早稲田大学、立命館大学、関西学院大学、上智大学、明治大学、青山学院大学、教授、准教授、ゼミ、単位、履修、卒論、修論

ジャンル「${genre.primary}」の固有名詞リスト:`;

  try {
    const response = await callGemini(prompt);
    // 改行やスペースを整理してカンマ区切りのリストにする
    const cleanedResponse = response
      .replace(/\n/g, '、')
      .replace(/、+/g, '、')
      .replace(/^、|、$/g, '')
      .trim();
    
    console.log('[Gemini] Generated genre keywords:', cleanedResponse.slice(0, 100) + '...');
    return cleanedResponse;
  } catch (error) {
    console.error('[Gemini] Failed to generate genre keywords:', error);
    return '';
  }
}

// Whisper用のプロンプトを構築
export function buildWhisperPrompt(
  teachContent: string,
  genreKeywords: string,
  detectedNouns: string[]
): string {
  const parts: string[] = [];
  
  // 教えるファイルの内容から固有名詞を抽出（最優先）
  if (teachContent && teachContent.trim()) {
    // 簡易的に固有名詞っぽい部分を抽出（カタカナ、漢字の連続など）
    const nouns = teachContent.match(/[ァ-ヶー]+|[一-龯]+[ァ-ヶー]*|[A-Za-z]+/g);
    if (nouns && nouns.length > 0) {
      const uniqueNouns = [...new Set(nouns)].slice(0, 30);
      parts.push(uniqueNouns.join('、'));
    }
  }
  
  // ジャンル別キーワード
  if (genreKeywords && genreKeywords.trim()) {
    parts.push(genreKeywords.slice(0, 200));
  }
  
  // 既に検出された固有名詞
  if (detectedNouns.length > 0) {
    parts.push(detectedNouns.slice(0, 15).join('、'));
  }
  
  // 結合して400文字に制限（Whisperの224トークン制限に対応）
  const combined = parts.join('、').slice(0, 400);
  
  console.log('[Whisper] Built prompt:', combined.slice(0, 100) + '...');
  return combined;
}


// TXTファイルの内容から関連する固有名詞・専門用語を生成（Whisperプロンプト用）
// TXT読み込み時に1回だけ呼び出され、TXT変更まで維持される
export async function generateKeywordsFromTeachFile(
  teachContent: string,
): Promise<string> {
  if (!teachContent || !teachContent.trim()) {
    return '';
  }

  const prompt = `以下のテキストは、音声認識の精度向上のためにユーザーが事前に入力した情報です。
このテキストに含まれる固有名詞と、それに関連しそうな固有名詞・専門用語を生成してください。

【ユーザーが入力したテキスト】:
${teachContent.slice(0, 500)}

【生成ルール】
1. テキストに直接含まれる固有名詞（人名、地名、組織名、製品名など）を抽出
2. それらに関連しそうな固有名詞も追加（例: 「同志社大学」があれば「京都」「今出川」「関西私大」なども）
3. 音声認識で間違いやすい単語を優先（例: 同志社→どうしても、慶應→けいおう）
4. 合計40〜60個程度の単語をカンマ区切りで出力
5. 説明は不要、単語のみ

【出力例】
同志社大学、同志社、京都、今出川、関西学院大学、立命館大学、関西大学、関関同立、教授、准教授、ゼミ、単位、履修、卒論、修論、田中、鈴木、佐藤

固有名詞リスト:`;

  try {
    const response = await callGemini(prompt);
    // 改行やスペースを整理してカンマ区切りのリストにする
    const cleanedResponse = response
      .replace(/\n/g, '、')
      .replace(/、+/g, '、')
      .replace(/^、|、$/g, '')
      .trim();
    
    console.log('[Gemini] Generated keywords from teach file:', cleanedResponse.slice(0, 150) + '...');
    return cleanedResponse;
  } catch (error) {
    console.error('[Gemini] Failed to generate keywords from teach file:', error);
    return '';
  }
}
