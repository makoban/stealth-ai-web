import { useState, useEffect, useRef, useCallback } from 'react';
import { useWhisperRecognition } from './hooks/useWhisperRecognition';
import { useAssemblyAI } from './hooks/useAssemblyAI';
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
import { exportToExcel } from './lib/excel';
import './App.css';

const APP_VERSION = 'v1.34';

// 音声認識エンジンの種類
type SpeechEngine = 'whisper' | 'assemblyai';
const ENGINE_LABELS: Record<SpeechEngine, string> = {
  whisper: 'Whisper',
  assemblyai: 'AssemblyAI',
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
  // 音声認識エンジン選択
  const [speechEngine, setSpeechEngine] = useState<SpeechEngine>(() => {
    const saved = localStorage.getItem('speech_engine');
    return (saved as SpeechEngine) || 'assemblyai'; // デフォルトはAssemblyAI
  });

  // OpenAI APIキー（ローカルストレージから読み込み）
  const [openaiApiKey, setOpenaiApiKey] = useState<string>(() => {
    const saved = localStorage.getItem('openai_api_key');
    return saved || OPENAI_API_KEY || '';
  });
  
  // 音声増幅倍率（自動調整、初期値は最大）
  const [gainValue, setGainValue] = useState<number>(50);

  const [showSettings, setShowSettings] = useState(false);

  // エンジン選択をローカルストレージに保存
  useEffect(() => {
    localStorage.setItem('speech_engine', speechEngine);
  }, [speechEngine]);

  // APIキーが変更されたらローカルストレージに保存
  useEffect(() => {
    if (openaiApiKey) {
      localStorage.setItem('openai_api_key', openaiApiKey);
    }
  }, [openaiApiKey]);

  // Whisper API
  const whisper = useWhisperRecognition({
    apiKey: openaiApiKey,
    intervalMs: 4000,
  });

  // AssemblyAI用の状態
  const [assemblyTranscript, setAssemblyTranscript] = useState('');
  const [assemblyInterim, setAssemblyInterim] = useState('');
  const [currentSpeaker, setCurrentSpeaker] = useState<string | undefined>();

  // AssemblyAI
  const assemblyAI = useAssemblyAI({
    onTranscript: (text, isFinal, speaker) => {
      if (isFinal) {
        setAssemblyTranscript(prev => prev + (prev ? ' ' : '') + text);
        setAssemblyInterim('');
        setCurrentSpeaker(speaker);
      } else {
        setAssemblyInterim(text);
      }
    },
  });

  // 統合された音声認識状態
  const transcript = speechEngine === 'whisper' ? whisper.transcript : assemblyTranscript;
  const interimTranscript = speechEngine === 'whisper' ? whisper.interimTranscript : assemblyInterim;
  const isListening = speechEngine === 'whisper' ? whisper.isListening : assemblyAI.isListening;
  const audioLevel = speechEngine === 'whisper' ? whisper.audioLevel : assemblyAI.audioLevel / 100;
  const isClipping = speechEngine === 'whisper' ? whisper.isClipping : false;
  const isSpeechDetected = speechEngine === 'whisper' ? whisper.isSpeechDetected : assemblyAI.audioLevel > 10;
  const isSupported = true;
  const speechError = speechEngine === 'whisper' ? whisper.error : assemblyAI.error;

  // 統合された操作関数
  const startListening = useCallback(async () => {
    if (speechEngine === 'whisper') {
      whisper.startListening();
    } else {
      setAssemblyTranscript('');
      setAssemblyInterim('');
      await assemblyAI.startListening();
    }
  }, [speechEngine, whisper, assemblyAI]);

  const stopListening = useCallback(() => {
    if (speechEngine === 'whisper') {
      whisper.stopListening();
    } else {
      assemblyAI.stopListening();
    }
  }, [speechEngine, whisper, assemblyAI]);

  const clearTranscript = useCallback(() => {
    if (speechEngine === 'whisper') {
      whisper.clearTranscript();
    } else {
      setAssemblyTranscript('');
      setAssemblyInterim('');
    }
  }, [speechEngine, whisper]);

  const setGain = whisper.setGain;

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
        HARDCODED_API_KEY
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

  // テキストを処理（修正、固有名詞検出）
  const processText = useCallback(async (text: string) => {
    console.log('[App] processText called:', text);
    if (!text.trim()) {
      console.log('[App] Skipping processText - empty text');
      return;
    }

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

      // 固有名詞を検出（知識レベルに応じて）
      const nouns = await detectProperNouns(corrected.correctedText, knowledgeLevel, HARDCODED_API_KEY);

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
            url: explanations[0].url,
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
          return updated;
        });

        filteredSegments.forEach(segment => {
          console.log('[App] Calling processText:', segment.trim());
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
          <div className="api-usage" onClick={() => setShowSettings(true)}>
            <span>API: {apiUsage.gemini.callCount + apiUsage.whisper.callCount}回</span>
            <span>${apiUsage.totalCost.toFixed(4)}</span>
            <button onClick={(e) => { e.stopPropagation(); resetAllUsageStats(); setApiUsage(getTotalApiUsageStats()); }} className="reset-btn">↻</button>
          </div>
          <span className="engine-badge" onClick={() => setShowSettings(true)}>
            {speechEngine === 'assemblyai' ? '🏆' : '🐬'} {ENGINE_LABELS[speechEngine]}
          </span>
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
        {/* リアルタイム欄 */}
        <section className="section realtime-section">
          <div className={`realtime-text ${isSpeechDetected ? 'active' : ''}`}>
            {currentSpeaker && speechEngine === 'assemblyai' && (
              <span className="speaker-label">話者{currentSpeaker}: </span>
            )}
            {interimTranscript || (isListening ? '音声を待機中...' : '会話解析を開始してください')}
          </div>
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
                  <div key={index} className="word-entry animate-fadeIn">
                    <div className="word-header">
                      <span className="word-name">{word.word}</span>
                      <span className="word-category">{word.category}</span>
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
          className="control-btn excel"
          onClick={() => exportToExcel(conversations, summaryHistory, lookedUpWords)}
          disabled={conversations.length === 0 && summaryHistory.length === 0 && lookedUpWords.length === 0}
        >
          📊 エクセル出力
        </button>
        <button
          className={`control-btn record ${isListening ? 'recording' : ''}`}
          onClick={toggleRecording}
        >
          {isListening ? '⏹️ 解析停止' : '🎙️ 会話解析'}
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
              <h3>🎯 音声認識エンジン</h3>
              <div className="engine-selector">
                <button
                  className={`engine-btn ${speechEngine === 'assemblyai' ? 'active' : ''}`}
                  onClick={() => setSpeechEngine('assemblyai')}
                  disabled={isListening}
                >
                  🏆 AssemblyAI（最高品質）
                </button>
                <button
                  className={`engine-btn ${speechEngine === 'whisper' ? 'active' : ''}`}
                  onClick={() => setSpeechEngine('whisper')}
                  disabled={isListening}
                >
                  🐬 Whisper
                </button>
              </div>
              <p className="engine-description">
                {speechEngine === 'assemblyai' 
                  ? '✅ 話者分離対応・最高精度・ノイズ耐性◎' 
                  : 'ℹ️ 標準品質・ノイズフィルターあり'}
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
          {speechError}
        </div>
      )}
    </div>
  );
}
