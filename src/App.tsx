import { useState, useEffect, useRef, useCallback } from 'react';
import { UserMenu } from './components/UserMenu';
import { MemoryButtons } from './components/MemoryButtons';
import { useAuth } from './contexts/AuthContext';
import { useWhisperRecognition } from './hooks/useWhisperRecognition';
// AssemblyAIは日本語非対応のため削除済み
import {
  detectProperNounsExtended,
  investigateProperNoun,
  summarizeConversation,
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

import { exportToExcel } from './lib/excel';
import './App.css';

const APP_VERSION = 'v2.7';



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
  timestamp: Date;
}

type ExpandedSection = 'none' | 'conversation' | 'summary' | 'lookup';

export default function App() {
  // 認証情報を取得
  const { user, userData } = useAuth();
  
  // 音声増幅倍率（自動調整、初期値は最大）
  const [gainValue, setGainValue] = useState<number>(50);

  const [showSettings, setShowSettings] = useState(false);

  // Whisperプロンプト用（フック使用前に定義が必要）
  const [whisperPrompt, setWhisperPrompt] = useState<string>('');
  const [teachFileKeywords, setTeachFileKeywords] = useState<string>(''); // TXT読み込み時に生成、TXT変更まで維持
  const [genreKeywords, setGenreKeywords] = useState<string>('');
  const detectedNounsRef = useRef<string[]>([]); // 検出済み固有名詞

  // Whisper API
  const whisper = useWhisperRecognition({
    intervalMs: 4000,
    whisperPrompt: whisperPrompt, // ジャンル・教えるファイル・検出済み固有名詞から構築
  });

  // Whisperの音声認識状態
  const transcript = whisper.transcript;
  const interimTranscript = whisper.interimTranscript;
  const isListening = whisper.isListening;
  const audioLevel = whisper.audioLevel;
  const isClipping = whisper.isClipping;
  const isSpeechDetected = whisper.isSpeechDetected;
  const isSupported = true;
  const speechError = whisper.error;

  // Whisperの操作関数
  const startListening = useCallback(() => {
    whisper.startListening();
  }, [whisper]);

  const stopListening = useCallback(() => {
    whisper.stopListening();
  }, [whisper]);

  const clearTranscript = useCallback(() => {
    whisper.clearTranscript();
  }, [whisper]);

  const setGain = whisper.setGain;

  const [knowledgeLevel, setKnowledgeLevel] = useState<KnowledgeLevel>('high');
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

  const lastProcessedTranscript = useRef('');
  const conversationSummaryRef = useRef<ConversationSummary | null>(null);
  const processedWordsRef = useRef<Set<string>>(new Set());

  // API使用量を定期更新
  useEffect(() => {
    const interval = setInterval(() => {
      setApiUsage(getTotalApiUsageStats());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

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
  
  // Whisperプロンプトを構築（TXTキーワード・ジャンルキーワード・検出済み固有名詞から）
  useEffect(() => {
    // TXT読み込み時に生成したキーワードを優先使用
    const prompt = buildWhisperPrompt(teachFileKeywords || combinedMemoryContent, genreKeywords, detectedNounsRef.current);
    setWhisperPrompt(prompt);
    console.log('[App] Whisper prompt updated:', prompt.slice(0, 100) + '...');
  }, [combinedMemoryContent, teachFileKeywords, genreKeywords]);

  // 要約を更新
  const updateSummary = useCallback(async (conversation: string) => {
    console.log('[App] updateSummary called, length:', conversation.length);
    if (conversation.length < 50) {
      console.log('[App] Skipping summary - text too short');
      return;
    }

    try {
      const result = await summarizeConversation(
        conversation,
        conversationSummaryRef.current?.summary || null,
        
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
            timestamp: new Date(),
          };
          return [newEntry, ...prev.slice(0, 4)];
        });
      }
    } catch (e) {
      console.error('Summary error:', e);
    }
  }, []);

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

  // transcript変更を監視（リアルタイム欄から会話欄に移動したとき）
  useEffect(() => {
    console.log('[App] transcript changed:', { 
      transcript: transcript?.substring(0, 50), 
      lastProcessed: lastProcessedTranscript.current?.substring(0, 50) 
    });
    
    if (!transcript) return;

    const newText = transcript.slice(lastProcessedTranscript.current.length).trim();
    console.log('[App] newText:', newText);

    if (newText.length > 0) {
      lastProcessedTranscript.current = transcript;

      const segments = newText.split('\n').filter(s => s.trim().length > 0);
      const filteredSegments = segments.filter(segment => !shouldFilterText(segment));
      console.log('[App] segments:', segments.length, 'filtered:', filteredSegments.length);

      if (filteredSegments.length > 0) {
        const filteredText = filteredSegments.join(' ');
        console.log('[App] Processing text:', filteredText);
        
        setFullConversation(prev => {
          const updated = prev + ' ' + filteredText;
          console.log('[App] fullConversation length:', updated.length);
          updateSummary(updated.trim());
          updateGenre(updated.trim()); // ジャンル推定も更新
          return updated;
        });

        // 会話欄移動時にGemini整形と固有名詞検出を実行
        filteredSegments.forEach(segment => {
          console.log('[App] Calling processText:', segment.trim());
          processText(segment.trim());
        });
      }
    }
  }, [transcript, updateSummary, updateGenre, processText]);

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

  // 接続状態の色
  const getConnectionColor = () => {
    if (!isListening) return '#999';
    return isSpeechDetected ? '#32CD32' : '#FF6B6B';
  };

  if (!isSupported) {
    return (
      <div className="app unsupported">
        <h1>🎤 ステルスAI</h1>
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
          <h1>🌟 ステルスAI</h1>
          <span className="version-badge">{APP_VERSION}</span>
          <div
            className="connection-indicator"
            style={{ backgroundColor: getConnectionColor() }}
          />
        </div>
        <div className="header-right">
          <UserMenu />

          {currentGenre && currentGenre.confidence > 0.5 && (
            <span className="genre-badge" title={`キーワード: ${currentGenre.keywords.join(', ')}\n${currentGenre.context}`}>
              🎯 {currentGenre.primary}
              {currentGenre.secondary.length > 0 && <span className="genre-sub">+{currentGenre.secondary.length}</span>}
            </span>
          )}
          {isDetectingGenre && (
            <span className="genre-badge detecting">🔍 分析中...</span>
          )}
          <button onClick={() => setShowLevelSelector(true)} className="level-btn">
            📚 {KNOWLEDGE_LEVEL_LABELS[knowledgeLevel]}
          </button>
          {isListening && (
            <div className="header-audio-level">
              <div className="header-level-bar" style={{ width: `${Math.min(audioLevel * 100 * 2, 100)}%` }} />
            </div>
          )}
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

        {/* リアルタイム欄（OpenAI出力をそのまま表示） */}
        <section className="section realtime-section">
          <div className={`realtime-text ${isSpeechDetected ? 'active' : ''}`}>

            {interimTranscript || (isListening ? '音声を待機中...' : '会話解析を開始してください')}
          </div>
        </section>

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
                      {entry.uncertainWords && entry.uncertainWords.length > 0 && (
                        <span className="uncertain"> ({entry.uncertainWords.join(', ')}?)</span>
                      )}
                    </span>
                    {entry.originalText && (
                      <span className="original-text">✅修正: {entry.originalText}</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>
        )}

        {/* 要約欄 */}
        {(expandedSection === 'none' || expandedSection === 'summary') && (
          <section
            className={`section summary-section ${expandedSection === 'summary' ? 'expanded' : ''}`}
            onClick={() => toggleSection('summary')}
          >
            <h2>📝 要約 {expandedSection === 'summary' ? '▼' : '▶'}</h2>
            <div className="section-content">
              {summaryHistory.length === 0 ? (
                <p className="placeholder">要約がここに表示されます</p>
              ) : (
                [...summaryHistory].reverse().map((entry, index) => (
                  <div key={index} className="summary-entry animate-fadeIn">
                    <p className="summary-text">{entry.summary}</p>
                    {entry.topics.length > 0 && (
                      <div className="topics">
                        {entry.topics.map((topic, i) => (
                          <span key={i} className="topic-tag">{topic}</span>
                        ))}
                      </div>
                    )}
                    {(entry.context || entry.participants || entry.purpose) && (
                      <div className="summary-prediction">
                        {entry.context && <span className="prediction-item">🎬 {entry.context}</span>}
                        {entry.participants && <span className="prediction-item">👥 {entry.participants}</span>}
                        {entry.purpose && <span className="prediction-item">🎯 {entry.purpose}</span>}
                      </div>
                    )}
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
        <button
          className={`record-btn ${isListening ? 'recording' : ''}`}
          onClick={toggleRecording}
        >
          {isListening ? '⏹ 停止' : '🎤 開始'}
        </button>
        <button className="reset-btn" onClick={handleReset}>
          🗑 リセット
        </button>
        <button
          className="export-btn"
          onClick={() => exportToExcel(conversations, summaryHistory, lookedUpWords)}
          disabled={conversations.length === 0}
        >
          📊 Excel出力
        </button>
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
            <button onClick={() => setShowSettings(false)}>閉じる</button>
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
    </div>
  );
}
