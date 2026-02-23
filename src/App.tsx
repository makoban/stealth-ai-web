import { useState, useEffect, useRef, useCallback } from 'react';
import { UserMenu } from './components/UserMenu';
import { LegalPage } from './components/LegalPage';
import { MemoryButtons } from './components/MemoryButtons';
import { useAuth } from './contexts/AuthContext';
import { useWhisperRecognition } from './hooks/useWhisperRecognition';
// AssemblyAIは日本語非対応のため削除済み
import {
  detectProperNounsExtended,
  investigateProperNoun,
  summarizeConversation,
  summarizeIncremental,
  correctConversationWithGenre,
  detectConversationGenre,
  generateGenreKeywords,
  // generateKeywordsFromTeachFileはMemoryButtonに移動
  buildWhisperPrompt,
  getTotalApiUsageStats,
  resetAllUsageStats,
  KnowledgeLevel,
  KNOWLEDGE_LEVEL_LABELS,
  ConversationSummary,
  ConversationGenre,
  TotalApiUsageStats,
  ExtendedProperNounResult,
  ProperNoun,
} from './lib/gemini';
import { setPointsUpdateCallback } from './lib/whisper';

import { exportToExcel } from './lib/excel';
import './App.css';




const APP_VERSION = 'v3.39.0';

const APP_NAME = 'KUROKO +';

// カラーテーマの型と定義
type ColorTheme = 'business' | 'natural' | 'pop';

const THEME_LABELS: Record<ColorTheme, string> = {
  business: 'ビジネス',
  natural: 'ナチュラル',
  pop: 'ポップ',
};

// 文字サイズの型定義
type FontSize = 'xs' | 'sm' | 'md' | 'lg';

// 文字サイズラベル
const FONTSIZE_LABELS: Record<FontSize, string> = {
  xs: '極小',
  sm: '小',
  md: '中',
  lg: '大',
};



// ジャンル別の色クラスを取得
const getGenreColorClass = (genre: string): string => {
  const genreColors: Record<string, string> = {
    'ビジネス・仕事': 'business',
    'テクノロジー・IT': 'tech',
    '食べ物・グルメ': 'food',
    'スポーツ': 'sports',
    '音楽・エンタメ': 'music',
    '映画・ドラマ': 'movie',
    'ゲーム': 'game',
    '旅行・観光': 'travel',
    '健康・医療': 'health',
    '教育・学習': 'education',
    '政治・経済': 'politics',
    '科学・研究': 'science',
    'ファッション': 'fashion',
    '趣味・ホビー': 'hobby',
    '日常会話': 'daily',
    'その他': 'other',
  };
  return genreColors[genre] || 'other';
};

// ジャンル別のアイコンを取得
const getGenreIcon = (genre: string): string => {
  const genreIcons: Record<string, string> = {
    'ビジネス・仕事': '💼',
    'テクノロジー・IT': '💻',
    '食べ物・グルメ': '🍽️',
    'スポーツ': '⚽',
    '音楽・エンタメ': '🎵',
    '映画・ドラマ': '🎬',
    'ゲーム': '🎮',
    '旅行・観光': '✈️',
    '健康・医療': '🏥',
    '教育・学習': '📚',
    '政治・経済': '🏛️',
    '科学・研究': '🔬',
    'ファッション': '👗',
    '趣味・ホビー': '🎨',
    '日常会話': '💬',
    'その他': '📌',
  };
  return genreIcons[genre] || '📌';
};

// フィルタリングする不要なテキスト
const FILTERED_TEXTS = [
  'wakeup', 'wake up', '私のログイン', 'ログイン', 'login', 'log in',
  'ウェイクアップ', '起きて', '起こして', 'hey siri', 'ok google',
  'アレクサ', 'alexa', 'コルタナ', 'cortana',
];

const shouldFilterText = (text: string): boolean => {
  const lowerText = text.toLowerCase().trim();
  return FILTERED_TEXTS.some(filtered =>
    lowerText === filtered.toLowerCase() ||
    lowerText.includes(filtered.toLowerCase())
  );
};

// 会話エントリの型
interface ConversationEntry {
  id: string;
  text: string;
  originalText?: string;
  uncertainWords?: string[];
  timestamp: Date;
}

// 調べた単語の型
interface LookedUpWord {
  word: string;
  category: string;
  explanation: string;
  url?: string;
  timestamp: Date;
  confidence: number;           // 確信度
  isCandidate?: boolean;        // 候補かどうか
  alternativeCandidates?: {     // 他の候補
    name: string;
    description: string;
    confidence: number;
    url?: string;
  }[];
  needsVerification?: boolean;  // 要確認フラグ
}

// 要約履歴の型
interface SummaryEntry {
  summary: string;
  topics: string[];
  context?: string;      // 会話の場面予想
  participants?: string; // 参加者予想
  purpose?: string;      // 会話の目的予想
  clarity?: number;      // 明瞭度（0-1）
  detailedTopic?: string;    // 詳細トピック
  predictedWords?: string[]; // 予測単語
  timestamp: Date;
}

type ExpandedSection = 'none' | 'conversation' | 'summary' | 'lookup';

export default function App() {
  // 認証情報を取得
  const { user, userData, updatePoints, refreshUserData, updatePremiumStatus } = useAuth();
  
  // 決済成功後の処理（URLパラメータをチェック）
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const payment = urlParams.get('payment');
    const sessionId = urlParams.get('session_id');
    
    if (payment === 'success' && sessionId) {
      // URLパラメータをクリア
      window.history.replaceState({}, '', window.location.pathname);
      
      // ユーザーデータを更新（ポイントと有料会員ステータス）
      setTimeout(() => {
        refreshUserData();
        updatePremiumStatus(true);
        alert('🎉 購入ありがとうございます！\nポイントが追加されました。\n有料会員になりました！');
      }, 1000);
    } else if (payment === 'cancelled') {
      // URLパラメータをクリア
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [refreshUserData, updatePremiumStatus]);

  // ポイント更新コールバックを設定（リアルタイム更新用）
  // ポイント0で自動停止用のフラグと関数参照
  const pointsZeroStopRef = useRef<boolean>(false);
  const stopListeningRef = useRef<(() => void) | null>(null);

  // 音声増幅倍率（自動調整、初期値は最大）
  const [gainValue, setGainValue] = useState<number>(50);

  const [showSettings, setShowSettings] = useState(false);
  const [showGainAdjuster, setShowGainAdjuster] = useState(false);
  const [showLegalPage, setShowLegalPage] = useState<'terms' | 'privacy' | 'tokushoho' | null>(null);
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [showTermsAgreement, setShowTermsAgreement] = useState(false);
  const [hasAgreedTerms, setHasAgreedTerms] = useState<boolean>(() => {
    return localStorage.getItem('kuroko_terms_agreed') === 'true';
  });

  // 初回ログイン時に利用規約同意モーダルを表示
  useEffect(() => {
    if (user && !hasAgreedTerms) {
      setShowTermsAgreement(true);
    }
  }, [user, hasAgreedTerms]);

  // Whisperプロンプト用（フック使用前に定義が必要）
  const [whisperPrompt, setWhisperPrompt] = useState<string>('');
  const [teachFileKeywords, setTeachFileKeywords] = useState<string>(''); // TXT読み込み時に生成、TXT変更まで維持
  const [genreKeywords, setGenreKeywords] = useState<string>('');
  const detectedNounsRef = useRef<string[]>([]); // 検出済み固有名詞

  // バッファ準備完了時のコールバックをrefで管理（循環参照回避）
  const bufferReadyCallbackRef = useRef<((text: string) => void) | null>(null);
  
  // Whisper API
  const whisper = useWhisperRecognition({
    whisperPrompt: whisperPrompt,
    onBufferReady: (text: string) => {
      // ref経由でコールバックを呼び出す
      if (bufferReadyCallbackRef.current) {
        bufferReadyCallbackRef.current(text);
      }
    },
  });

  // Whisperの音声認識状態
  const transcript = whisper.transcript;
  const isListening = whisper.isListening;
  const audioLevel = whisper.audioLevel;
  const isClipping = whisper.isClipping;
  const currentGain = whisper.currentGain;
  const noiseFloor = whisper.noiseFloor;
  const vadState = whisper.vadState;
  // isSpeechDetectedは音量バーに置き換えたため削除
  // statusIconは音量バーに置き換えたため削除
  const isSupported = true;
  const speechError = whisper.error;

  // Whisperの操作関数
  const startListening = useCallback(() => {
    whisper.startListening();
  }, [whisper]);

  const stopListening = useCallback(() => {
    whisper.stopListening();
  }, [whisper]);

  // stopListeningをrefに保存（ポイント0で自動停止用）
  useEffect(() => {
    stopListeningRef.current = stopListening;
  }, [stopListening]);

  // ポイント更新コールバックを設定（リアルタイム更新用）
  useEffect(() => {
    if (user) {
      setPointsUpdateCallback((newPoints: number) => {
        console.log('[App] Points updated:', newPoints);
        updatePoints(newPoints);
        
        // ポイント0以下になったら自動停止
        if (newPoints <= 0 && !pointsZeroStopRef.current) {
          pointsZeroStopRef.current = true;
          console.log('[App] Points exhausted, stopping recording');
          // 少し遅延させて停止（現在の処理が完了してから）
          setTimeout(() => {
            if (stopListeningRef.current) {
              stopListeningRef.current();
            }
            alert('ポイントがなくなりました。録音を停止しました。');
            pointsZeroStopRef.current = false;
          }, 500);
        }
      });
    }
  }, [user, updatePoints]);

  const clearTranscript = useCallback(() => {
    whisper.clearTranscript();
  }, [whisper]);

  const setGain = whisper.setGain;
  const isAgcEnabled = whisper.isAgcEnabled;
  const toggleAgc = whisper.toggleAgc;

  const [knowledgeLevel, setKnowledgeLevel] = useState<KnowledgeLevel>('high');
  
  // カラーテーマ管理（デフォルト: ビジネス）
  const [colorTheme, setColorTheme] = useState<ColorTheme>(() => {
    const saved = localStorage.getItem('stealth_color_theme');
    return (saved as ColorTheme) || 'business';
  });
  
  // テーマ変更時にDOMとlocalStorageを更新
  useEffect(() => {
    if (colorTheme === 'business') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', colorTheme);
    }
    localStorage.setItem('stealth_color_theme', colorTheme);
  }, [colorTheme]);
  
  // 文字サイズ管理（デフォルト: 小）
  const [fontSize, setFontSize] = useState<FontSize>(() => {
    const saved = localStorage.getItem('stealth_font_size');
    return (saved as FontSize) || 'sm';
  });
  
  // 文字サイズ変更時にDOMとlocalStorageを更新
  useEffect(() => {
    document.documentElement.setAttribute('data-fontsize', fontSize);
    localStorage.setItem('stealth_font_size', fontSize);
  }, [fontSize]);

  // プチ記憶・完全記憶の内容
  const [petitMemoryContent, setPetitMemoryContent] = useState<string>('');
  const [fullMemoryContent, setFullMemoryContent] = useState<string>('');
  const [showLevelSelector, setShowLevelSelector] = useState(false);
  const [conversations, setConversations] = useState<ConversationEntry[]>([]);
  const [lookedUpWords, setLookedUpWords] = useState<LookedUpWord[]>([]);
  const [summaryHistory, setSummaryHistory] = useState<SummaryEntry[]>([]);
  const [fullConversation, setFullConversation] = useState('');
  const [expandedSection, setExpandedSection] = useState<ExpandedSection>('none');
  const [apiUsage, setApiUsage] = useState<TotalApiUsageStats>(getTotalApiUsageStats());
  
  // ジャンル推定
  const [currentGenre, setCurrentGenre] = useState<ConversationGenre | null>(null);
  const [isDetectingGenre, setIsDetectingGenre] = useState(false);
  const lastGenreUpdateRef = useRef<number>(0);
  
  // セッション時間管理（無料会員15分制限）
  const [sessionStartTime, setSessionStartTime] = useState<number | null>(null);
  const [sessionElapsedSeconds, setSessionElapsedSeconds] = useState(0);
  const FREE_SESSION_LIMIT_SECONDS = 15 * 60; // 15分

  const lastProcessedTranscript = useRef('');
  const conversationSummaryRef = useRef<ConversationSummary | null>(null);
  const processedWordsRef = useRef<Set<string>>(new Set());
  
  // インクリメンタル要約用（直近の会話のみを要約）
  const [latestSummary, setLatestSummary] = useState<string>('');
  const lastSummaryUpdateRef = useRef<number>(0);

  // API使用量を定期更新
  useEffect(() => {
    const interval = setInterval(() => {
      setApiUsage(getTotalApiUsageStats());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // セッション時間の計測（無料会員15分制限）
  useEffect(() => {
    if (!isListening) {
      setSessionStartTime(null);
      setSessionElapsedSeconds(0);
      return;
    }
    
    // 録音開始時にセッション開始時刻を記録
    if (!sessionStartTime) {
      setSessionStartTime(Date.now());
    }
    
    const interval = setInterval(() => {
      if (sessionStartTime) {
        const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
        setSessionElapsedSeconds(elapsed);
        
        // 無料会員は15分で自動停止
        const isPremium = userData?.isPremium || false;
        if (!isPremium && elapsed >= FREE_SESSION_LIMIT_SECONDS) {
          if (stopListeningRef.current) {
            stopListeningRef.current();
          }
          alert('無料会員は1セッション15分までです。\n有料会員になると時間無制限で使えます。');
        }
      }
    }, 1000);
    
    return () => clearInterval(interval);
  }, [isListening, sessionStartTime, userData?.isPremium]);

  // ログアウト時にすべての表示項目をクリア
  useEffect(() => {
    if (!user) {
      // ログアウト時に状態をリセット
      setConversations([]);
      setLookedUpWords([]);
      setSummaryHistory([]);
      setFullConversation('');
      setCurrentGenre(null);
      setPetitMemoryContent('');
      setFullMemoryContent('');
      setTeachFileKeywords('');
      setGenreKeywords('');
      setWhisperPrompt('');
      detectedNounsRef.current = [];
      lastProcessedTranscript.current = '';
      conversationSummaryRef.current = null;
      processedWordsRef.current = new Set();
      lastGenreUpdateRef.current = 0;
      clearTranscript();
      console.log('[App] Logged out - all state cleared');
    }
  }, [user, clearTranscript]);

  // 増幅倍率の変更をフックに反映
  useEffect(() => {
    setGain(gainValue);
  }, [gainValue, setGain]);

  // 増幅倍率の自動調整（音割れ時は下げる、無音時は最大に）
  useEffect(() => {
    if (!isListening) return;
    
    const currentLevel = audioLevel;
    
    if (isClipping && gainValue > 10) {
      // 音割れ時は増幅を下げる
      setGainValue(prev => Math.max(prev - 5, 10));
    } else if (currentLevel < 0.02 && gainValue < 50) {
      // ほぼ無音の場合は増幅を最大に
      setGainValue(50);
    } else if (currentLevel > 0.7 && gainValue > 10) {
      // 音が大きすぎる場合は少し下げる
      setGainValue(prev => Math.max(prev - 2, 10));
    }
  }, [audioLevel, isListening, gainValue, isClipping]);

  // プチ記憶と完全記憶を結合
  const combinedMemoryContent = [petitMemoryContent, fullMemoryContent].filter(Boolean).join('\n\n');
  
  // Whisperプロンプトを構築（動的プロンプト: 要約内容・予測単語・詳細トピックを含む）
  useEffect(() => {
    // 最新の要約から動的プロンプト情報を取得
    const latestSummary = summaryHistory.length > 0 ? summaryHistory[0] : null;
    const summaryContext = latestSummary?.summary || '';
    const predictedWords = latestSummary?.predictedWords || [];
    const detailedTopic = latestSummary?.detailedTopic || '';
    
    // TXT読み込み時に生成したキーワードを優先使用
    const prompt = buildWhisperPrompt(
      teachFileKeywords || combinedMemoryContent,
      genreKeywords,
      detectedNounsRef.current,
      summaryContext,
      predictedWords,
      detailedTopic
    );
    setWhisperPrompt(prompt);
    console.log('[App] Dynamic Whisper prompt updated:', prompt.slice(0, 100) + '...');
  }, [combinedMemoryContent, teachFileKeywords, genreKeywords, summaryHistory]);

  // インクリメンタル要約（直近の会話を素早く要約）
  const updateIncrementalSummary = useCallback(async (latestText: string) => {
    const now = Date.now();
    // 3秒以内の更新はスキップ（APIコール節約）
    if (now - lastSummaryUpdateRef.current < 3000) return;
    if (latestText.length < 30) return;
    
    lastSummaryUpdateRef.current = now;
    
    try {
      const summary = await summarizeIncremental(latestText, latestSummary || null);
      if (summary) {
        setLatestSummary(summary);
        console.log('[App] Incremental summary updated:', summary);
      }
    } catch (e) {
      console.error('Incremental summary error:', e);
    }
  }, [latestSummary]);

  // 要約を更新（過去3会話+現在の会話を分析）- バックグラウンドで実行
  const updateSummary = useCallback(async (conversation: string) => {
    console.log('[App] updateSummary called, length:', conversation.length);
    if (conversation.length < 50) {
      console.log('[App] Skipping summary - text too short');
      return;
    }
    
    // インクリメンタル要約を先に実行（リアルタイム性重視）
    updateIncrementalSummary(conversation);

    try {
      // 過去3会話を取得（最新3件の会話テキスト）
      const recentConversations = conversations
        .slice(-3)
        .map(c => c.text);
      
      const result = await summarizeConversation(
        conversation,
        conversationSummaryRef.current?.summary || null,
        recentConversations,
      );

      if (result.summary) {
        conversationSummaryRef.current = result;
        setSummaryHistory(prev => {
          const newEntry: SummaryEntry = {
            summary: result.summary,
            topics: result.topics,
            context: result.context,
            participants: result.participants,
            purpose: result.purpose,
            clarity: result.clarity,
            detailedTopic: result.detailedTopic,
            predictedWords: result.predictedWords,
            timestamp: new Date(),
          };
          return [newEntry, ...prev.slice(0, 4)];
        });
        // 詳細要約も更新
        setLatestSummary(result.summary);
      }
    } catch (e) {
      console.error('Summary error:', e);
    }
  }, [conversations, updateIncrementalSummary]);

  // ジャンルを推定
  const updateGenre = useCallback(async (conversation: string) => {
    // 最後のジャンル更新から10秒以上経過、かつ100文字以上の会話がある場合のみ更新
    const now = Date.now();
    if (now - lastGenreUpdateRef.current < 10000) return;
    if (conversation.length < 100) return;
    if (isDetectingGenre) return;
    
    setIsDetectingGenre(true);
    lastGenreUpdateRef.current = now;
    
    try {
      const previousGenres = currentGenre 
        ? [currentGenre.primary, ...currentGenre.secondary]
        : null;
      
      const genre = await detectConversationGenre(
        conversation,
        previousGenres,
        
      );
      
      console.log('[App] Genre detected:', genre);
      setCurrentGenre(genre);
      
      // ジャンル別キーワードを生成（Whisperプロンプト用）
      if (genre && genre.confidence > 0.5) {
        try {
          const keywords = await generateGenreKeywords(
            genre,
            combinedMemoryContent,
            detectedNounsRef.current,
            
          );
          setGenreKeywords(keywords);
          console.log('[App] Genre keywords generated:', keywords.slice(0, 100) + '...');
        } catch (e) {
          console.error('[App] Failed to generate genre keywords:', e);
        }
      }
    } catch (e) {
      console.error('Genre detection error:', e);
    } finally {
      setIsDetectingGenre(false);
    }
  }, [currentGenre, isDetectingGenre, combinedMemoryContent]);

  // テキストを処理（Gemini整形、拡張固有名詞検出）- 会話欄移動時に呼ばれる
  const processText = useCallback(async (text: string) => {
    console.log('[App] processText called:', text);
    if (!text.trim()) {
      console.log('[App] Skipping processText - empty text');
      return;
    }

    try {
      // 会話をGeminiで整形（文脈・ジャンル・教えるファイルを考慮して正確な日本語に）
      const corrected = await correctConversationWithGenre(text, fullConversation, currentGenre, combinedMemoryContent);

      const entry: ConversationEntry = {
        id: Date.now().toString(),
        text: corrected.correctedText,
        originalText: corrected.wasModified ? text : undefined,
        uncertainWords: corrected.uncertainWords,
        timestamp: new Date(),
      };

      setConversations(prev => [...prev, entry]);

      // 整形後のテキストから拡張固有名詞検出（候補を含む幅広い検出）
      const result: ExtendedProperNounResult = await detectProperNounsExtended(
        corrected.correctedText,
        knowledgeLevel,
        currentGenre,
        fullConversation,
        
      );

      // 知識レベルに応じた閾値設定
      // 小学生: 何でも調べる（閾値低め）
      // 専門家: 本当に専門的なものだけ（閾値高め）
      const levelThresholds: Record<KnowledgeLevel, { confirmed: number; candidate: number; includeCandidates: boolean }> = {
        elementary: { confirmed: 0.5, candidate: 0.3, includeCandidates: true },   // 小学生: 何でも調べる
        middle: { confirmed: 0.6, candidate: 0.4, includeCandidates: true },       // 中学生: 幅広く調べる
        high: { confirmed: 0.7, candidate: 0.5, includeCandidates: true },         // 高校生: やや絞る
        university: { confirmed: 0.75, candidate: 0.6, includeCandidates: false }, // 大学生: 確実なもの中心
        expert: { confirmed: 0.85, candidate: 0.8, includeCandidates: false },     // 専門家: 本当に専門的なものだけ
      };

      const thresholds = levelThresholds[knowledgeLevel];

      // 知識レベルに応じて固有名詞を統合
      const allNouns: (ProperNoun & { source: string })[] = [
        ...result.confirmed.map(n => ({ ...n, source: 'confirmed' })),
        // 候補は知識レベルが低い場合のみ含める
        ...(thresholds.includeCandidates ? result.candidates.map(n => ({ ...n, source: 'candidate' })) : []),
        ...(thresholds.includeCandidates ? result.possibleNames.map(n => ({ ...n, source: 'name' })) : []),
        ...(thresholds.includeCandidates ? result.possiblePlaces.map(n => ({ ...n, source: 'place' })) : []),
        ...(thresholds.includeCandidates ? result.possibleOrgs.map(n => ({ ...n, source: 'org' })) : []),
      ];

      console.log('[App] Detected nouns:', allNouns.length, 'confirmed:', result.confirmed.length, 'candidates:', result.candidates.length, 'level:', knowledgeLevel);

      // 検出した固有名詞をWhisperプロンプト用に保存
      const newNouns = allNouns.map(n => n.word);
      detectedNounsRef.current = [...new Set([...detectedNounsRef.current, ...newNouns])].slice(-50);

      for (const noun of allNouns) {
        if (processedWordsRef.current.has(noun.word)) continue;
        // 知識レベルに応じた閾値を適用
        const confidenceThreshold = noun.source === 'confirmed' ? thresholds.confirmed : thresholds.candidate;
        if (noun.confidence < confidenceThreshold) continue;

        processedWordsRef.current.add(noun.word);

        // 詳細調査（複数候補を取得）
        const candidates = await investigateProperNoun(
          noun.word,
          noun.category,
          fullConversation,
          currentGenre,
          knowledgeLevel,
          
        );

        if (candidates.length > 0) {
          const primary = candidates[0];
          const alternatives = candidates.slice(1);

          setLookedUpWords(prev => [...prev, {
            word: noun.word,
            category: noun.category,
            explanation: primary.description,
            url: primary.url,
            timestamp: new Date(),
            confidence: noun.confidence,
            isCandidate: noun.source !== 'confirmed',
            alternativeCandidates: alternatives.length > 0 ? alternatives.map(c => ({
              name: c.name,
              description: c.description,
              confidence: c.confidence,
              url: c.url,
            })) : undefined,
            needsVerification: noun.needsVerification || noun.source !== 'confirmed',
          }]);
        }
      }
    } catch (e) {
      console.error('Detection error:', e);
    }
  }, [fullConversation, knowledgeLevel, currentGenre, combinedMemoryContent]);

  // バッファ準備完了時のコールバックを設定（processText定義後に設定）
  useEffect(() => {
    bufferReadyCallbackRef.current = (text: string) => {
      console.log('[App] Buffer ready for Gemini:', text);
      if (!text.trim()) return;
      
      // フィルタリング
      if (shouldFilterText(text)) {
        console.log('[App] Filtered text:', text);
        return;
      }
      
      // fullConversationを更新
      setFullConversation(prev => {
        const updated = prev + ' ' + text;
        console.log('[App] fullConversation length:', updated.length);
        updateSummary(updated.trim());
        updateGenre(updated.trim());
        return updated;
      });
      
      // Gemini整形と固有名詞検出を実行
      console.log('[App] Calling processText from buffer:', text);
      processText(text.trim());
    };
  }, [updateSummary, updateGenre, processText]);

  // transcript変更を監視（fullConversation更新のみ、会話欄追加はonBufferReadyで行う）
  useEffect(() => {
    console.log('[App] transcript changed:', { 
      transcript: transcript?.substring(0, 50), 
      lastProcessed: lastProcessedTranscript.current?.substring(0, 50) 
    });
    
    if (!transcript) return;

    const newText = transcript.slice(lastProcessedTranscript.current.length).trim();

    if (newText.length > 0) {
      lastProcessedTranscript.current = transcript;

      const segments = newText.split('\n').filter(s => s.trim().length > 0);
      const filteredSegments = segments.filter(segment => !shouldFilterText(segment));

      if (filteredSegments.length > 0) {
        const filteredText = filteredSegments.join(' ');
        
        // fullConversationのみ更新（要約・ジャンル推定用）
        // 会話欄への追加はonBufferReadyで行うため、ここではprocessTextを呼ばない
        setFullConversation(prev => {
          const updated = prev + ' ' + filteredText;
          updateSummary(updated.trim());
          updateGenre(updated.trim());
          return updated;
        });
      }
    }
  }, [transcript, updateSummary, updateGenre]);

  // 録音開始/停止
  const toggleRecording = () => {
    if (isListening) {
      stopListening();
    } else {
      // ログインチェック
      if (!user) {
        alert('ログインが必要です。右上の「ログイン」ボタンからログインしてください。');
        return;
      }
      // ポイントチェック
      if (!userData || userData.points <= 0) {
        alert('ポイントが不足しています。ポイントを購入してください。');
        return;
      }
      startListening();
    }
  };

  // セクション拡大/縮小
  const toggleSection = (section: ExpandedSection) => {
    setExpandedSection(prev => prev === section ? 'none' : section);
  };

  // リセット
  const handleReset = () => {
    clearTranscript();
    setConversations([]);
    setLookedUpWords([]);
    setSummaryHistory([]);
    setFullConversation('');
    conversationSummaryRef.current = null;
    processedWordsRef.current.clear();
    lastProcessedTranscript.current = '';
    resetAllUsageStats();
    setApiUsage(getTotalApiUsageStats());
    setCurrentGenre(null);
    lastGenreUpdateRef.current = 0;
    // インクリメンタル要約のリセット
    setLatestSummary('');
    lastSummaryUpdateRef.current = 0;
    // Whisperプロンプト関連のリセット（ジャンルキーワードと検出済み固有名詞）
    setGenreKeywords('');
    detectedNounsRef.current = [];
    // 記憶もリセット
    setPetitMemoryContent('');
    setFullMemoryContent('');
    setTeachFileKeywords('');
    setWhisperPrompt('');
    // localStorageのフル記憶もクリア
    localStorage.removeItem('stealth_full_memory_name');
    localStorage.removeItem('stealth_full_memory_path');
  };

  if (!isSupported) {
    return (
      <div className="app unsupported">
        <h1>🎤 {APP_NAME}</h1>
        <p>このブラウザは音声認識をサポートしていません。</p>
        <p>Chrome、Safari、またはEdgeをお使いください。</p>
      </div>
    );
  }

  return (
    <div className="app">
      {/* ヘッダー */}
      <header className="header">
        <div className="header-left">
          {/* ロゴ（タップでバージョンモーダル表示） */}
          <div 
            className="app-logo-container" 
            onClick={() => setShowVersionModal(true)}
            title={`${APP_NAME} ${APP_VERSION}`}
          >
            <img src="/logo.png" alt="KUROKO+" className="app-logo-icon" />
            <span className="app-logo-text">KUROKO+</span>
          </div>
          {/* テーマ切り替えアイコン */}
          <button
            className="icon-btn theme-icon-btn"
            onClick={() => {
              const themes: ColorTheme[] = ['business', 'natural', 'pop'];
              const currentIndex = themes.indexOf(colorTheme);
              const nextIndex = (currentIndex + 1) % themes.length;
              setColorTheme(themes[nextIndex]);
            }}
            title={`テーマ: ${THEME_LABELS[colorTheme]}`}
          >
            🎨
          </button>
          {/* 文字サイズ切り替えアイコン */}
          <button
            className="icon-btn fontsize-icon-btn"
            onClick={() => {
              const sizes: FontSize[] = ['xs', 'sm', 'md', 'lg'];
              const currentIndex = sizes.indexOf(fontSize);
              const nextIndex = (currentIndex + 1) % sizes.length;
              setFontSize(sizes[nextIndex]);
            }}
            title={`文字サイズ: ${FONTSIZE_LABELS[fontSize]}`}
          >
            🔤
          </button>
        </div>
        <div className="header-right">
          {/* VAD状態表示 + 音量レベルバー（5本）- タップでゲイン調整 */}
          <div 
            className={`audio-level-bars clickable ${vadState === 'speech' || vadState === 'maybe_silence' ? 'speaking' : ''}`}
            title={`ゲイン: ${currentGain}x | ノイズフロア: ${noiseFloor.toFixed(3)} | VAD: ${vadState}`}
            onClick={() => setShowGainAdjuster(true)}
          >
            {[0.3, 0.4, 0.5, 0.6, 0.7].map((threshold, i) => {
              const isActive = audioLevel > threshold;
              // VAD状態に応じて色を変更
              const isSpeaking = vadState === 'speech' || vadState === 'maybe_silence';
              let hue = 240 - (i * 48); // デフォルト: 青→オレンジ
              if (isSpeaking && isActive) {
                hue = 120; // 発話中は緑
              }
              return (
                <div
                  key={i}
                  className={`level-bar ${isActive ? 'active' : ''}`}
                  style={{
                    backgroundColor: isActive ? `hsl(${hue}, 80%, 50%)` : '#333',
                  }}
                />
              );
            })}
          </div>
          <button onClick={() => setShowLevelSelector(true)} className="level-btn-large">
            📚 {KNOWLEDGE_LEVEL_LABELS[knowledgeLevel]}
          </button>
          <UserMenu />
        </div>
      </header>

      {/* メインコンテンツ */}
      <main className="main-content">
        {/* 記憶欄（プチ記憶・完全記憶） */}
        <div className="teach-container">
          <MemoryButtons
            onPetitChange={(content) => {
              setPetitMemoryContent(content);
              console.log('[App] Petit memory updated:', content.slice(0, 50) + '...');
            }}
            onFullChange={(content, keywords) => {
              setFullMemoryContent(content);
              if (keywords) {
                setTeachFileKeywords(keywords);
              }
              console.log('[App] Full memory updated:', content.slice(0, 50) + '...');
            }}
            onClear={(type) => {
              if (type === 'petit') {
                setPetitMemoryContent('');
              } else {
                setFullMemoryContent('');
                setTeachFileKeywords('');
              }
            }}
            petitContent={petitMemoryContent}
            fullContent={fullMemoryContent}
          />
        </div>

        {/* 会話欄（Gemini整形後のテキスト） */}
        {(expandedSection === 'none' || expandedSection === 'conversation') && (
          <section
            className={`section conversation-section ${expandedSection === 'conversation' ? 'expanded' : ''}`}
            onClick={() => toggleSection('conversation')}
          >
            <h2>💬 会話 {expandedSection === 'conversation' ? '▼' : '▶'}</h2>
            <div className="section-content">
              {conversations.length === 0 ? (
                <p className="placeholder">会話がここに表示されます</p>
              ) : (
                [...conversations].reverse().map(entry => (
                  <div key={entry.id} className="conversation-entry animate-fadeIn">
                    <span className="entry-text">
                      {entry.text}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        )}

        {/* 要約欄（ジャンル別背景色付き） */}
        {(expandedSection === 'none' || expandedSection === 'summary') && (
          <section
            className={`section summary-section ${expandedSection === 'summary' ? 'expanded' : ''} ${currentGenre ? `genre-${getGenreColorClass(currentGenre.primary)}` : ''}`}
            onClick={() => toggleSection('summary')}
          >
            <h2>
              {currentGenre && <span className={`genre-icon genre-${getGenreColorClass(currentGenre.primary)}`}>{getGenreIcon(currentGenre.primary)}</span>}
              📋 {latestSummary || (summaryHistory.length > 0 ? summaryHistory[0].summary.slice(0, 20) : '要約')}
              {expandedSection === 'summary' ? ' ▼' : ' ▶'}
            </h2>
            <div className="section-content">
              {summaryHistory.length === 0 ? (
                <p className="placeholder">要約がここに表示されます</p>
              ) : (
                [...summaryHistory].reverse().map((entry, index) => (
                  <div key={index} className="summary-entry animate-fadeIn">
                    <p className="summary-text">{entry.summary}</p>
                  </div>
                ))
              )}
            </div>
          </section>
        )}

        {/* 調べた単語欄 */}
        {(expandedSection === 'none' || expandedSection === 'lookup') && (
          <section
            className={`section lookup-section ${expandedSection === 'lookup' ? 'expanded' : ''}`}
            onClick={() => toggleSection('lookup')}
          >
            <h2>🔍 調べた単語 {expandedSection === 'lookup' ? '▼' : '▶'}</h2>
            <div className="section-content">
              {lookedUpWords.length === 0 ? (
                <p className="placeholder">固有名詞の説明がここに表示されます</p>
              ) : (
                [...lookedUpWords].reverse().map((word, index) => (
                  <div key={index} className={`word-entry animate-fadeIn ${word.isCandidate ? 'candidate' : ''} ${word.needsVerification ? 'needs-verification' : ''}`}>
                    <div className="word-header">
                      <span className="word-name">{word.word}</span>
                      <span className="word-category">{word.category}</span>
                      {word.isCandidate && <span className="candidate-badge">候補</span>}
                      {word.needsVerification && <span className="verification-badge">要確認</span>}
                      <span className="confidence-badge" style={{ opacity: word.confidence }}>
                        {Math.round(word.confidence * 100)}%
                      </span>
                    </div>
                    <p className="word-explanation">{word.explanation}</p>
                    {word.url && (
                      <a
                        href={word.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="word-url"
                        onClick={(e) => e.stopPropagation()}
                      >
                        🔗 参考リンク
                      </a>
                    )}
                    {/* 他の候補表示 */}
                    {word.alternativeCandidates && word.alternativeCandidates.length > 0 && (
                      <div className="alternative-candidates">
                        <div className="alternatives-header">💡 他の可能性:</div>
                        {word.alternativeCandidates.map((alt, altIndex) => (
                          <div key={altIndex} className="alternative-item">
                            <span className="alt-name">{alt.name}</span>
                            <span className="alt-confidence">({Math.round(alt.confidence * 100)}%)</span>
                            <p className="alt-description">{alt.description}</p>
                            {alt.url && (
                              <a
                                href={alt.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="alt-url"
                                onClick={(e) => e.stopPropagation()}
                              >
                                🔗 参考
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>
        )}
      </main>

      {/* フッター */}
      <footer className="footer">
        <div className="footer-main-controls">
          <button
            className={`record-btn ${isListening ? 'recording' : ''}`}
            onClick={toggleRecording}
          >
            {isListening ? '⏹ 停止' : '🎙 開始'}
          </button>
          
          {/* セッション時間表示（無料会員のみ） */}
          {isListening && !userData?.isPremium && (
            <div className="session-timer">
              <span className="timer-label">残り</span>
              <span className="timer-value">
                {Math.max(0, Math.floor((FREE_SESSION_LIMIT_SECONDS - sessionElapsedSeconds) / 60))}:
                {String(Math.max(0, (FREE_SESSION_LIMIT_SECONDS - sessionElapsedSeconds) % 60)).padStart(2, '0')}
              </span>
            </div>
          )}
        </div>

        <div className="footer-sub-controls">
          <button className="reset-btn" onClick={handleReset}>
            🗑 リセット
          </button>
          <button
            className="export-btn"
            onClick={() => {
              if (!userData?.isPremium) {
                alert('🔒 Excel出力は有料会員限定機能です。\nポイントを購入すると有料会員になります。');
                return;
              }
              exportToExcel(conversations, summaryHistory, lookedUpWords);
            }}
            disabled={conversations.length === 0}
          >
            📊 Excel{!userData?.isPremium && '🔒'}
          </button>
        </div>
      </footer>

      {/* エラー表示 */}
      {speechError && (
        <div className="error-toast">
          ⚠️ {speechError}
        </div>
      )}

      {/* 設定モーダル */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>⚙️ 設定</h2>

            <div className="setting-item">
              <label>ポイント残高</label>
              <div className="api-stats">
                <p><strong>{userData ? `${userData.points}pt` : 'ログインしてください'}</strong></p>
                <p className="setting-info">※ 1pt = 1円で購入可能</p>
              </div>
            </div>
            <div className="setting-item">
              <label>今回の使用状況</label>
              <div className="api-stats">
                <p>Gemini: {apiUsage.gemini.callCount}回</p>
                <p>Whisper: {apiUsage.whisper.callCount}回 ({(apiUsage.whisper.totalDurationSeconds / 60).toFixed(1)}分)</p>
              </div>
            </div>
            <div className="setting-item legal-links">
              <label>法的情報</label>
              <div className="legal-buttons">
                <button
                  className="legal-link-btn"
                  onClick={() => {
                    setShowSettings(false);
                    setShowLegalPage('terms');
                  }}
                >
                  利用規約
                </button>
                <button
                  className="legal-link-btn"
                  onClick={() => {
                    setShowSettings(false);
                    setShowLegalPage('privacy');
                  }}
                >
                  プライバシーポリシー
                </button>
                <button
                  className="legal-link-btn"
                  onClick={() => {
                    setShowSettings(false);
                    setShowLegalPage('tokushoho');
                  }}
                >
                  特定商取引法に基づく表示
                </button>
              </div>
            </div>
            <button onClick={() => setShowSettings(false)}>閉じる</button>
          </div>
        </div>
      )}

      {/* 法的文書モーダル */}
      {showLegalPage && (
        <LegalPage
          type={showLegalPage}
          onClose={() => setShowLegalPage(null)}
        />
      )}

      {/* ゲイン調整モーダル */}
      {showGainAdjuster && (
        <div className="modal-overlay" onClick={() => setShowGainAdjuster(false)}>
          <div className="modal gain-modal" onClick={(e) => e.stopPropagation()}>
            <h2>🎙️ マイクゲイン調整</h2>
            
            {/* AGCトグル */}
            <div className="agc-toggle-container">
              <label className="agc-toggle">
                <input
                  type="checkbox"
                  checked={isAgcEnabled}
                  onChange={toggleAgc}
                />
                <span className="agc-toggle-slider"></span>
              </label>
              <span className="agc-toggle-label">
                常時自動調整 {isAgcEnabled ? 'ON' : 'OFF'}
              </span>
            </div>
            
            <p className="gain-description">
              {isAgcEnabled 
                ? 'VAD→AGC構造: 発話中のみゲインを自動調整' 
                : '手動でゲインを調整してください'
              }
            </p>
            
            {/* VAD状態とノイズフロア表示 */}
            <div className="vad-status-display">
              <div className="vad-row">
                <span>VAD状態: </span>
                <span className={`vad-state ${vadState}`}>
                  {vadState === 'silence' && '🔇 無音'}
                  {vadState === 'maybe_speech' && '🔉 検出中...'}
                  {vadState === 'speech' && '🗣️ 発話中'}
                  {vadState === 'maybe_silence' && '🔈 終了判定中...'}
                </span>
              </div>
              <div className="vad-row">
                <span>ノイズフロア: </span>
                <span className="noise-floor-value">{(noiseFloor * 100).toFixed(1)}%</span>
                <span className="threshold-info">
                  (開始: {(noiseFloor * 2.5 * 100).toFixed(0)}% / 終了: {(noiseFloor * 1.5 * 100).toFixed(0)}%)
                </span>
              </div>
            </div>
            
            {/* 現在の音量レベル表示 */}
            <div className="current-level-display">
              <span>現在の音量: </span>
              <span className="level-value">{(audioLevel * 100).toFixed(0)}%</span>
              <span className="level-bar-mini">
                <span 
                  className="level-fill" 
                  style={{ width: `${Math.min(audioLevel * 100, 100)}%` }}
                />
              </span>
            </div>
            
            <div className="gain-slider-container">
              <div className="gain-value-display">
                <span className="gain-value">{currentGain}x</span>
              </div>
              <input
                type="range"
                min="10"
                max="10000"
                step="10"
                value={Math.min(currentGain, 10000)}
                onChange={(e) => {
                  const newGain = parseInt(e.target.value, 10);
                  setGain(newGain);
                }}
                className="gain-slider"
              />
              <div className="gain-labels">
                <span>低 (10x)</span>
                <span>高 (10,000x)</span>
              </div>
            </div>
            <div className="gain-presets">
              <button 
                className={`gain-preset ${currentGain <= 50 ? 'active' : ''}`}
                onClick={() => setGain(30)}
              >
                💻 PC
              </button>
              <button 
                className={`gain-preset ${currentGain > 50 && currentGain <= 200 ? 'active' : ''}`}
                onClick={() => setGain(100)}
              >
                ⚖️ 標準
              </button>
              <button 
                className={`gain-preset ${currentGain > 200 && currentGain <= 1000 ? 'active' : ''}`}
                onClick={() => setGain(500)}
              >
                📱 スマホ
              </button>
              <button 
                className={`gain-preset ${currentGain > 1000 ? 'active' : ''}`}
                onClick={() => setGain(2000)}
              >
                📱 iPhone
              </button>
            </div>
            <button onClick={() => setShowGainAdjuster(false)}>閉じる</button>
          </div>
        </div>
      )}

      {/* 知識レベル選択モーダル */}
      {showLevelSelector && (
        <div className="modal-overlay" onClick={() => setShowLevelSelector(false)}>
          <div className="modal level-modal" onClick={(e) => e.stopPropagation()}>
            <h2>📚 知識レベル設定</h2>
            <p className="level-description">
              あなたの知識レベルを選択してください。<br />
              選択したレベルで「知らない」と思われる単語を調べます。
            </p>
            <div className="level-options">
              {(Object.keys(KNOWLEDGE_LEVEL_LABELS) as KnowledgeLevel[]).map((level) => (
                <button
                  key={level}
                  className={`level-option ${knowledgeLevel === level ? 'selected' : ''}`}
                  onClick={() => {
                    setKnowledgeLevel(level);
                    setShowLevelSelector(false);
                  }}
                >
                  <span className="level-name">{KNOWLEDGE_LEVEL_LABELS[level]}</span>
                  <span className="level-hint">
                    {level === 'elementary' && '何でも調べる'}
                    {level === 'middle' && '幅広く調べる'}
                    {level === 'high' && '一般的な用語は除外'}
                    {level === 'university' && '専門用語中心'}
                    {level === 'expert' && 'ニッチな用語のみ'}
                  </span>
                </button>
              ))}
            </div>
            <button onClick={() => setShowLevelSelector(false)}>閉じる</button>
          </div>
        </div>
      )}

      {/* バージョンモーダル */}
      {showVersionModal && (
        <div className="modal-overlay" onClick={() => setShowVersionModal(false)}>
          <div className="modal version-modal" onClick={(e) => e.stopPropagation()}>
            <div className="version-header">
              <img src="/logo.png" alt="KUROKO+" className="version-logo" />
              <h2>{APP_NAME}</h2>
              <p className="version-number">{APP_VERSION}</p>
            </div>
            <div className="version-legal-links">
              <button 
                className="legal-link-btn"
                onClick={() => {
                  setShowVersionModal(false);
                  setShowLegalPage('terms');
                }}
              >
                📄 利用規約
              </button>
              <button 
                className="legal-link-btn"
                onClick={() => {
                  setShowVersionModal(false);
                  setShowLegalPage('privacy');
                }}
              >
                🔒 プライバシーポリシー
              </button>
              <button 
                className="legal-link-btn"
                onClick={() => {
                  setShowVersionModal(false);
                  setShowLegalPage('tokushoho');
                }}
              >
                🏢 特定商取引法に基づく表示
              </button>
            </div>
            <p className="version-copyright">© 2026 株式会社バンテックス（販売）/ 株式会社ビークリエイティブ（開発）</p>
            <button onClick={() => setShowVersionModal(false)}>閉じる</button>
          </div>
        </div>
      )}

      {/* 利用規約同意モーダル（初回ログイン時） */}
      {showTermsAgreement && !showLegalPage && (
        <div className="modal-overlay terms-agreement-overlay">
          <div className="modal terms-agreement-modal" onClick={(e) => e.stopPropagation()}>
            <div className="terms-agreement-header">
              <img src="/logo.png" alt="KUROKO+" className="terms-logo" />
              <h2>KUROKO+ へようこそ</h2>
            </div>
            <p className="terms-agreement-description">
              ご利用いただく前に、利用規約およびプライバシーポリシーをご確認ください。
            </p>
            <div className="terms-agreement-links">
              <button 
                className="terms-link-btn"
                onClick={() => setShowLegalPage('terms')}
              >
                📄 利用規約を読む
              </button>
              <button 
                className="terms-link-btn"
                onClick={() => setShowLegalPage('privacy')}
              >
                🔒 プライバシーポリシーを読む
              </button>
            </div>
            <div className="terms-agreement-notice">
              <p>⚠️ 本アプリは周囲の会話を音声認識します。</p>
              <p>会話当事者の同意を得てからご利用ください。</p>
            </div>
            <button 
              className="terms-agree-btn"
              onClick={() => {
                localStorage.setItem('kuroko_terms_agreed', 'true');
                setHasAgreedTerms(true);
                setShowTermsAgreement(false);
              }}
            >
              同意して利用を開始する
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
