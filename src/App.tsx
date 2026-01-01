import { useState, useEffect, useRef, useCallback } from 'react';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { useWhisperRecognition } from './hooks/useWhisperRecognition';
import {
  detectProperNouns,
  explainProperNoun,
  summarizeConversation,
  correctConversation,
  getTotalApiUsageStats,
  resetAllUsageStats,
  HARDCODED_API_KEY,
  KnowledgeLevel,
  KNOWLEDGE_LEVEL_LABELS,
  ConversationSummary,
  TotalApiUsageStats,
} from './lib/gemini';
import { OPENAI_API_KEY } from './lib/whisper';
import './App.css';

const APP_VERSION = 'v1.15';

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
  timestamp: Date;
}

// 要約履歴の型
interface SummaryEntry {
  summary: string;
  topics: string[];
  timestamp: Date;
}

type ExpandedSection = 'none' | 'conversation' | 'summary' | 'lookup';
type RecognitionMode = 'web' | 'whisper';

export default function App() {
  // 認識モード（Web Speech API or Whisper）
  const [recognitionMode, setRecognitionMode] = useState<RecognitionMode>('web');
  const [openaiApiKey, setOpenaiApiKey] = useState<string>(() => {
    // ローカルストレージから読み込み
    const saved = localStorage.getItem('openai_api_key');
    return saved || OPENAI_API_KEY || '';
  });
  const [showSettings, setShowSettings] = useState(false);

  // APIキーが変更されたらローカルストレージに保存
  useEffect(() => {
    if (openaiApiKey) {
      localStorage.setItem('openai_api_key', openaiApiKey);
    }
  }, [openaiApiKey]);

  // Web Speech API
  const webSpeech = useSpeechRecognition();

  // Whisper API
  const whisperSpeech = useWhisperRecognition({
    apiKey: openaiApiKey,
    intervalMs: 3000,
    gainValue: 3.0,
  });

  // 現在のモードに応じて使用する認識結果を選択
  const currentRecognition = recognitionMode === 'whisper' ? whisperSpeech : webSpeech;
  const {
    transcript,
    interimTranscript,
    isListening,
    isSpeechDetected,
    audioLevel,
    startListening,
    stopListening,
    clearTranscript,
    isSupported,
    error: speechError,
  } = currentRecognition;

  // Web Speech API固有のプロパティ
  const connectionStatus = recognitionMode === 'web' ? (webSpeech as any).connectionStatus : 'connected';
  const allCandidates = recognitionMode === 'web' ? (webSpeech as any).allCandidates || [] : [];

  const [knowledgeLevel, setKnowledgeLevel] = useState<KnowledgeLevel>('high');
  const [showLevelSelector, setShowLevelSelector] = useState(false);
  const [conversations, setConversations] = useState<ConversationEntry[]>([]);
  const [lookedUpWords, setLookedUpWords] = useState<LookedUpWord[]>([]);
  const [summaryHistory, setSummaryHistory] = useState<SummaryEntry[]>([]);
  const [fullConversation, setFullConversation] = useState('');
  const [expandedSection, setExpandedSection] = useState<ExpandedSection>('none');
  const [apiUsage, setApiUsage] = useState<TotalApiUsageStats>(getTotalApiUsageStats());

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

  // 要約を更新
  const updateSummary = useCallback(async (conversation: string) => {
    if (conversation.length < 50) return;

    try {
      const result = await summarizeConversation(
        conversation,
        conversationSummaryRef.current?.summary || null,
        HARDCODED_API_KEY
      );

      if (result.summary) {
        conversationSummaryRef.current = result;
        setSummaryHistory(prev => {
          const newEntry = {
            summary: result.summary,
            topics: result.topics,
            timestamp: new Date(),
          };
          // 最新の要約のみ保持（または最大5件）
          return [newEntry, ...prev.slice(0, 4)];
        });
      }
    } catch (e) {
      console.error('Summary error:', e);
    }
  }, []);

  // テキストを処理（修正、固有名詞検出）
  const processText = useCallback(async (text: string) => {
    if (!text.trim()) return;

    try {
      // 会話を修正
      const corrected = await correctConversation(text, fullConversation, HARDCODED_API_KEY);

      const entry: ConversationEntry = {
        id: Date.now().toString(),
        text: corrected.correctedText,
        originalText: corrected.wasModified ? text : undefined,
        uncertainWords: corrected.uncertainWords,
        timestamp: new Date(),
      };

      setConversations(prev => [...prev, entry]);

      // 固有名詞を検出
      const nouns = await detectProperNouns(corrected.correctedText, HARDCODED_API_KEY);

      for (const noun of nouns) {
        if (processedWordsRef.current.has(noun.word)) continue;
        if (noun.confidence < 0.7) continue;

        processedWordsRef.current.add(noun.word);

        const explanations = await explainProperNoun(
          noun.word,
          noun.category,
          fullConversation,
          knowledgeLevel,
          HARDCODED_API_KEY
        );

        if (explanations.length > 0) {
          setLookedUpWords(prev => [...prev, {
            word: noun.word,
            category: noun.category,
            explanation: explanations[0].description,
            timestamp: new Date(),
          }]);
        }
      }
    } catch (e) {
      console.error('Detection error:', e);
    }
  }, [fullConversation, knowledgeLevel]);

  // transcript変更を監視
  useEffect(() => {
    if (!transcript) return;

    const newText = transcript.slice(lastProcessedTranscript.current.length).trim();

    if (newText.length > 0) {
      lastProcessedTranscript.current = transcript;

      const segments = newText.split('\n').filter(s => s.trim().length > 0);
      const filteredSegments = segments.filter(segment => !shouldFilterText(segment));

      if (filteredSegments.length > 0) {
        const filteredText = filteredSegments.join(' ');
        setFullConversation(prev => {
          const updated = prev + ' ' + filteredText;
          updateSummary(updated.trim());
          return updated;
        });

        filteredSegments.forEach(segment => {
          processText(segment.trim());
        });
      }
    }
  }, [transcript, updateSummary, processText]);

  // 録音開始/停止
  const toggleRecording = () => {
    if (isListening) {
      stopListening();
    } else {
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
  };

  // 接続状態の色
  const getConnectionColor = () => {
    if (!isListening) return '#999';
    if (connectionStatus === 'connected') return isSpeechDetected ? '#32CD32' : '#FF6B6B';
    if (connectionStatus === 'reconnecting') return '#FFA500';
    return '#FF6B6B';
  };

  // モード切り替え
  const handleModeChange = (mode: RecognitionMode) => {
    if (isListening) {
      stopListening();
    }
    setRecognitionMode(mode);
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
            title={connectionStatus}
          />
        </div>
        <div className="header-right">
          <div className="api-usage" onClick={() => setShowSettings(true)}>
            <span>API: {apiUsage.gemini.callCount + apiUsage.whisper.callCount}回</span>
            <span>${apiUsage.totalCost.toFixed(4)}</span>
            <button onClick={(e) => { e.stopPropagation(); resetAllUsageStats(); setApiUsage(getTotalApiUsageStats()); }} className="reset-btn">↻</button>
          </div>
          <button onClick={() => setShowLevelSelector(true)} className="level-btn">
            📚 {KNOWLEDGE_LEVEL_LABELS[knowledgeLevel]}
          </button>
        </div>
      </header>

      {/* メインコンテンツ */}
      <main className="main-content">
        {/* リアルタイム欄 */}
        <section className="section realtime-section">
          <div className="realtime-header">
            <h2>🎙️ リアルタイム</h2>
            <div className="mode-selector">
              <button
                className={`mode-btn ${recognitionMode === 'web' ? 'active' : ''}`}
                onClick={() => handleModeChange('web')}
                disabled={isListening}
              >
                Web
              </button>
              <button
                className={`mode-btn ${recognitionMode === 'whisper' ? 'active' : ''}`}
                onClick={() => handleModeChange('whisper')}
                disabled={isListening}
              >
                Whisper
              </button>
            </div>
          </div>
          {isListening && (
            <div className="audio-level-container">
              <div className="audio-level-bar" style={{ width: `${audioLevel * 100}%` }} />
              <span className="audio-level-text">{(audioLevel * 100).toFixed(0)}%</span>
            </div>
          )}
          <div className={`realtime-text ${isSpeechDetected ? 'active' : ''}`}>
            {interimTranscript || (isListening ? '音声を待機中...' : '録音を開始してください')}
          </div>
          {recognitionMode === 'web' && allCandidates.length > 0 && (
            <div className="candidates-list">
              <small>候補: {allCandidates.slice(0, 3).join(' | ')}</small>
            </div>
          )}
        </section>

        {/* 会話欄 */}
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
                conversations.map(entry => (
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
                summaryHistory.map((entry, index) => (
                  <div key={index} className="summary-entry animate-fadeIn">
                    <p className="summary-text">{entry.summary}</p>
                    {entry.topics.length > 0 && (
                      <div className="topics">
                        {entry.topics.map((topic, i) => (
                          <span key={i} className="topic-tag">{topic}</span>
                        ))}
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
                lookedUpWords.map((word, index) => (
                  <div key={index} className="word-entry animate-fadeIn">
                    <div className="word-header">
                      <span className="word-name">{word.word}</span>
                      <span className="word-category">{word.category}</span>
                    </div>
                    <p className="word-explanation">{word.explanation}</p>
                  </div>
                ))
              )}
            </div>
          </section>
        )}
      </main>

      {/* コントロールバー */}
      <footer className="control-bar">
        <button className="control-btn reset" onClick={handleReset}>
          🗑️ リセット
        </button>
        <button
          className={`control-btn record ${isListening ? 'recording' : ''}`}
          onClick={toggleRecording}
        >
          {isListening ? '⏹️ 録音停止' : '🎤 録音開始'}
        </button>
      </footer>

      {/* 知識レベル選択モーダル */}
      {showLevelSelector && (
        <div className="modal-overlay" onClick={() => setShowLevelSelector(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>📚 知識レベル</h2>
            <div className="level-options">
              {(Object.keys(KNOWLEDGE_LEVEL_LABELS) as KnowledgeLevel[]).map(level => (
                <button
                  key={level}
                  className={`level-option ${knowledgeLevel === level ? 'selected' : ''}`}
                  onClick={() => {
                    setKnowledgeLevel(level);
                    setShowLevelSelector(false);
                  }}
                >
                  {KNOWLEDGE_LEVEL_LABELS[level]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 設定モーダル */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal settings-modal" onClick={e => e.stopPropagation()}>
            <h2>⚙️ 設定 & API使用量</h2>
            
            <div className="settings-section">
              <h3>認識モード</h3>
              <p className="settings-description">
                <strong>Web:</strong> 無料（ブラウザ内蔵）<br/>
                <strong>Whisper:</strong> 高精度・高感度（$0.006/分）
              </p>
            </div>

            <div className="settings-section">
              <h3>OpenAI APIキー（Whisper用）</h3>
              <input
                type="password"
                value={openaiApiKey}
                onChange={(e) => setOpenaiApiKey(e.target.value)}
                placeholder="sk-proj-..."
                className="api-key-input"
              />
            </div>

            <div className="settings-section">
              <h3>API使用量</h3>
              <div className="usage-details">
                <div className="usage-row">
                  <span>Gemini（AI処理）:</span>
                  <span>{apiUsage.gemini.callCount}回 / ${apiUsage.gemini.estimatedCost.toFixed(4)}</span>
                </div>
                <div className="usage-row">
                  <span>Whisper（音声認識）:</span>
                  <span>{apiUsage.whisper.callCount}回 / ${apiUsage.whisper.estimatedCost.toFixed(4)}</span>
                </div>
                <div className="usage-row total">
                  <span>合計:</span>
                  <span>${apiUsage.totalCost.toFixed(4)}</span>
                </div>
              </div>
            </div>

            <button className="close-btn" onClick={() => setShowSettings(false)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* エラー表示 */}
      {speechError && (
        <div className="error-toast">
          音声認識エラー: {speechError}
        </div>
      )}
    </div>
  );
}
