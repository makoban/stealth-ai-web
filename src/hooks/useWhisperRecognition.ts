import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioRecorder, transcribeAudio } from '../lib/whisper';

export type RecognitionState = 'idle' | 'starting' | 'listening' | 'processing' | 'stopping';

export interface UseWhisperRecognitionOptions {
  intervalMs?: number; // 音声を送信する間隔（ミリ秒）
  silenceThreshold?: number; // 無音と判定する閾値（0-1）
  whisperPrompt?: string; // Whisper APIに渡すプロンプト（固有名詞のヒント）
  onBufferReady?: (text: string) => void; // バッファが準備できた時のコールバック（Gemini送信用）
}

// Whisperの幻覚（hallucination）としてよく出るフレーズ
// 完全一致でフィルタリングするフレーズ
const HALLUCINATION_EXACT = [
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございます',
  'ご覧いただきありがとうございました',
  'ご覧いただきありがとうございます',
  '本日はご覧いただきありがとうございます',
  '本日はご覧いただきありがとうございました',
  'ありがとうございました',
  'ありがとうございます',
  'お疲れ様でした',
  'よい一日を',
  '良い一日を',
  'おやすみなさい',
  'さようなら',
  'またね',
  'バイバイ',
  '終わり',
  'おしまい',
  'Thank you for watching',
  'Thanks for watching',
  'Subscribe',
  'Like and subscribe',
  'MochiMochi',
  'Amara.org',
  'www.',
  'http',
  '.com',
  '.jp',
  '...',
  '。。。',
  '…',
];

// 部分一致でフィルタリングするフレーズ
const HALLUCINATION_PARTIAL = [
  'チャンネル登録',
  '高評価とチャンネル登録',
  '字幕',
  'subtitles',
  'ご視聴',
  '視聴',
  'ご覧いただき',
  'ご覧頂き',
  'お聴き',
  'お聞き',
  '次回',
  '次の動画',
  'また会いましょう',
  'お楽しみに',
  '提供',
  'スポンサー',
  '広告',
  'CM',
  'コマーシャル',
];

// 幻覚フレーズかどうかをチェック
function isHallucination(text: string): boolean {
  const normalized = text.trim();
  const normalizedLower = normalized.toLowerCase();
  
  // 完全一致チェック
  for (const phrase of HALLUCINATION_EXACT) {
    if (normalized === phrase || normalizedLower === phrase.toLowerCase()) {
      console.log('[Whisper] Hallucination detected (exact):', normalized);
      return true;
    }
  }
  
  // 部分一致チェック
  for (const phrase of HALLUCINATION_PARTIAL) {
    if (normalizedLower.includes(phrase.toLowerCase())) {
      console.log('[Whisper] Hallucination detected (partial):', normalized, 'matched:', phrase);
      return true;
    }
  }
  
  // 短すぎるテキストはノイズの可能性が高い（4文字以下）
  if (normalized.length <= 4) {
    console.log('[Whisper] Hallucination detected (too short):', normalized);
    return true;
  }
  
  // 「！」で終わる短いフレーズは幻覚の可能性が高い
  if (normalized.endsWith('!') && normalized.length < 15) {
    console.log('[Whisper] Hallucination detected (short exclamation):', normalized);
    return true;
  }
  
  // 同じ文字の繰り返し（例: "ああああ", "んんんん"）
  if (/^(.)\1{3,}$/.test(normalized)) {
    console.log('[Whisper] Hallucination detected (repeated char):', normalized);
    return true;
  }
  
  // 音楽記号や特殊文字のみ
  if (/^[♪♫♬♭♮♯♩●○■□▲△★☆※→←↑↓　 ]+$/.test(normalized)) {
    console.log('[Whisper] Hallucination detected (special chars only):', normalized);
    return true;
  }
  
  return false;
}

export function useWhisperRecognition(options: UseWhisperRecognitionOptions = {}) {
  const {
    silenceThreshold = 0.05, // 5%以下は無音と判定
    whisperPrompt = '', // Whisperに渡すプロンプト
    onBufferReady, // バッファ準備完了コールバック
  } = options;

  const [transcript, setTranscript] = useState<string>('');
  const [interimTranscript, setInterimTranscript] = useState<string>('');
  const [state, setState] = useState<RecognitionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState<boolean>(false);
  const [isSpeechDetected, setIsSpeechDetected] = useState<boolean>(false);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [isClipping, setIsClipping] = useState<boolean>(false);
  const [currentGain, setCurrentGain] = useState<number>(50); // 初期値は最大
  const [processingStatus, setProcessingStatus] = useState<string>('');

  const recorderRef = useRef<AudioRecorder | null>(null);
  const isProcessingRef = useRef<boolean>(false);
  const pendingTextRef = useRef<string>('');
  
  // タイプライターアニメーション用
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayedTextRef = useRef<string>(''); // 現在表示中のテキスト
  const targetTextRef = useRef<string>(''); // 目標テキスト（タイプライター用）
  
  // ダブルバッファ方式（取りこぼし防止）
  const bufferARef = useRef<string>(''); // バッファA
  const bufferBRef = useRef<string>(''); // バッファB
  const activeBufferRef = useRef<'A' | 'B'>('A'); // 現在書き込み中のバッファ
  const bufferSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 0.4秒無音タイマー
  const BUFFER_SILENCE_DURATION = 400; // バッファ送信までの無音時間（0.4秒）
  
  const whisperPromptRef = useRef<string>(whisperPrompt);
  const onBufferReadyRef = useRef(onBufferReady);
  const recentAudioLevelsRef = useRef<number[]>([]); // 最近の音声レベルを記録
  const maxAudioLevelRef = useRef<number>(0); // 期間中の最大音声レベル
  
  // VAD（無音検出）用 - 無音0.4秒で送信
  const speechStartTimeRef = useRef<number | null>(null); // 発話開始時刻
  const silenceStartTimeRef = useRef<number | null>(null); // 無音開始時刻
  const vadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // VADタイムアウト
  const VAD_SILENCE_DURATION = 400; // 無音と判定する時間（0.4秒）
  const VAD_MIN_SPEECH_DURATION = 300; // 最低発話時間（0.3秒）
  const VAD_MAX_SPEECH_DURATION = 15000; // 最大発話時間（15秒）
  const VAD_SPEECH_THRESHOLD = 0.015; // 発話と判定する閾値（1.5%）

  // コールバックをrefで保持
  useEffect(() => {
    onBufferReadyRef.current = onBufferReady;
  }, [onBufferReady]);

  // プロンプトをrefで保持（再レンダリングを防ぐ）
  useEffect(() => {
    whisperPromptRef.current = whisperPrompt;
    console.log('[Whisper] Prompt updated:', whisperPrompt?.slice(0, 50) + '...');
  }, [whisperPrompt]);

  // サポート確認
  useEffect(() => {
    const supported = typeof navigator.mediaDevices !== 'undefined' && 
      typeof navigator.mediaDevices.getUserMedia === 'function';
    setIsSupported(supported);
    if (!supported) {
      setError('このブラウザは音声録音をサポートしていません。');
    }
  }, []);

  // アクティブバッファを取得
  const getActiveBuffer = useCallback(() => {
    return activeBufferRef.current === 'A' ? bufferARef : bufferBRef;
  }, []);

  // アクティブバッファにテキストを追加
  const appendToActiveBuffer = useCallback((text: string) => {
    const buffer = getActiveBuffer();
    if (buffer.current) {
      buffer.current += ' ' + text;
    } else {
      buffer.current = text;
    }
    console.log(`[Buffer] Appended to buffer ${activeBufferRef.current}:`, buffer.current);
  }, [getActiveBuffer]);

  // バッファを切り替えてGeminiに送信
  const swapAndFlushBuffer = useCallback(() => {
    const currentBuffer = activeBufferRef.current;
    const bufferToSend = currentBuffer === 'A' ? bufferARef : bufferBRef;
    const textToSend = bufferToSend.current.trim();
    
    if (textToSend && onBufferReadyRef.current) {
      console.log(`[Buffer] Swapping: ${currentBuffer} -> ${currentBuffer === 'A' ? 'B' : 'A'}`);
      console.log(`[Buffer] Sending buffer ${currentBuffer} to Gemini:`, textToSend);
      
      // バッファを切り替え（次のWhisper結果は別のバッファに書き込まれる）
      activeBufferRef.current = currentBuffer === 'A' ? 'B' : 'A';
      
      // 送信するバッファをクリア
      bufferToSend.current = '';
      
      // Geminiに送信
      onBufferReadyRef.current(textToSend);
      
      // 表示をリセット
      displayedTextRef.current = '';
      targetTextRef.current = '';
      if (animationTimerRef.current) {
        clearTimeout(animationTimerRef.current);
        animationTimerRef.current = null;
      }
      
      // 新しいアクティブバッファの内容を表示
      const newActiveBuffer = getActiveBuffer();
      if (newActiveBuffer.current) {
        setInterimTranscript(`💬 ${newActiveBuffer.current}`);
      } else {
        setInterimTranscript('🎤 次の音声を待機中...');
      }
    }
  }, [getActiveBuffer]);

  // タイプライターアニメーション開始
  const startTypingAnimation = useCallback((newText: string) => {
    // 既存のアニメーションをキャンセル
    if (animationTimerRef.current) {
      clearTimeout(animationTimerRef.current);
    }
    
    // 目標テキストを設定
    targetTextRef.current = newText;
    
    const animate = () => {
      const target = targetTextRef.current;
      const current = displayedTextRef.current;
      
      if (current.length < target.length) {
        // 1文字追加
        displayedTextRef.current = target.slice(0, current.length + 1);
        setInterimTranscript(`💬 ${displayedTextRef.current}`);
        
        // 次の文字を表示（50ms間隔）
        animationTimerRef.current = setTimeout(animate, 50);
      }
    };
    
    animate();
  }, []);

  // バッファ無音タイマーをリセット
  const resetBufferSilenceTimer = useCallback(() => {
    if (bufferSilenceTimerRef.current) {
      clearTimeout(bufferSilenceTimerRef.current);
    }
    
    // アクティブバッファにテキストがある場合のみタイマーを設定
    const activeBuffer = getActiveBuffer();
    if (activeBuffer.current.trim()) {
      bufferSilenceTimerRef.current = setTimeout(() => {
        swapAndFlushBuffer();
      }, BUFFER_SILENCE_DURATION);
    }
  }, [getActiveBuffer, swapAndFlushBuffer]);

  // ゲイン値の変更（録音中でもリアルタイムに反映）
  const setGain = useCallback((value: number) => {
    setCurrentGain(value);
    if (recorderRef.current) {
      recorderRef.current.setGain(value);
    }
  }, []);

  // 定期的に音声を送信して文字起こし
  const processAudio = useCallback(async () => {
    if (!recorderRef.current) {
      console.log('[Whisper] No recorder');
      return;
    }
    if (isProcessingRef.current) {
      console.log('[Whisper] Already processing');
      return;
    }
    if (!recorderRef.current.isRecording()) {
      console.log('[Whisper] Not recording');
      return;
    }

    // 最大音声レベルをチェック（無音の場合はスキップ）
    const maxLevel = maxAudioLevelRef.current;
    console.log('[Whisper] Max audio level in period:', maxLevel);
    
    if (maxLevel < silenceThreshold) {
      console.log('[Whisper] Silence detected, skipping API call');
      setProcessingStatus(`無音検出（レベル: ${(maxLevel * 100).toFixed(0)}%）`);
      // データをクリアして次の期間へ
      recorderRef.current.getIntermediateBlob();
      maxAudioLevelRef.current = 0;
      recentAudioLevelsRef.current = [];
      return;
    }

    const blob = recorderRef.current.getIntermediateBlob();
    console.log('[Whisper] Got blob:', blob?.size || 0, 'bytes');
    
    // 最大レベルをリセット
    maxAudioLevelRef.current = 0;
    recentAudioLevelsRef.current = [];
    
    // 最小サイズチェック（WAVヘッダー44バイト + 最低限のデータ）
    if (!blob || blob.size < 1000) {
      setProcessingStatus('音声データ不足');
      return;
    }

    isProcessingRef.current = true;
    setProcessingStatus('Whisper APIに送信中...');
    
    // 処理中の表示
    const activeBuffer = getActiveBuffer();
    if (activeBuffer.current) {
      setInterimTranscript(`☁️ ${activeBuffer.current}...`);
    } else {
      setInterimTranscript('☁️ クラウドで解析中...');
    }

    try {
      console.log('[Whisper] Sending to API with prompt...');
      const result = await transcribeAudio(blob, whisperPromptRef.current);
      console.log('[Whisper] Result:', result);
      
      if (result.text && result.text.trim()) {
        const newText = result.text.trim();
        
        // 幻覚フレーズをフィルタリング
        if (isHallucination(newText)) {
          console.log('[Whisper] Filtered hallucination:', newText);
          setProcessingStatus('ノイズ除去（幻覚フィルタ）');
          setInterimTranscript('🎤 次の音声を待機中...');
        } else {
          // 認識成功
          console.log('[Whisper] Recognized text:', newText);
          
          // アクティブバッファに追加
          appendToActiveBuffer(newText);
          
          // タイプライターアニメーション開始
          const currentActiveBuffer = getActiveBuffer();
          startTypingAnimation(currentActiveBuffer.current);
          
          // バッファ無音タイマーをリセット（0.4秒後にGemini送信）
          resetBufferSilenceTimer();
          
          // 会話欄にも追加（生のWhisper出力）
          setTranscript((prev) => {
            const newTranscript = prev ? prev + '\n' + newText : newText;
            console.log('[Whisper] New transcript:', newTranscript);
            return newTranscript;
          });
          
          setProcessingStatus('認識成功: ' + newText.substring(0, 20) + '...');
        }
      } else {
        setProcessingStatus('音声なし（無音）');
        // バッファがあれば表示を維持
        const activeBuffer = getActiveBuffer();
        if (!activeBuffer.current) {
          setInterimTranscript('🎤 次の音声を待機中...');
        }
      }
    } catch (e) {
      console.error('[Whisper] Transcription error:', e);
      setProcessingStatus('エラー: ' + (e instanceof Error ? e.message : '不明'));
      if (e instanceof Error && e.message.includes('401')) {
        setError('OpenAI APIキーが無効です。設定を確認してください。');
      } else if (e instanceof Error && e.message.includes('429')) {
        setError('API制限に達しました。しばらく待ってください。');
      }
    } finally {
      isProcessingRef.current = false;
    }
  }, [silenceThreshold, getActiveBuffer, appendToActiveBuffer, startTypingAnimation, resetBufferSilenceTimer]);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('音声録音はサポートされていません');
      return;
    }

    setError(null);
    setState('starting');
    pendingTextRef.current = '';
    bufferARef.current = '';
    bufferBRef.current = '';
    activeBufferRef.current = 'A';
    displayedTextRef.current = '';
    targetTextRef.current = '';
    maxAudioLevelRef.current = 0;
    recentAudioLevelsRef.current = [];
    setProcessingStatus('開始中...');

    try {
      const recorder = new AudioRecorder();
      recorder.setGain(currentGain);
      
      await recorder.start((level, clipping) => {
        setAudioLevel(level);
        setIsClipping(clipping);
        // 最大レベルを更新
        if (level > maxAudioLevelRef.current) {
          maxAudioLevelRef.current = level;
        }
        recentAudioLevelsRef.current.push(level);
        // 最新100件のみ保持
        if (recentAudioLevelsRef.current.length > 100) {
          recentAudioLevelsRef.current.shift();
        }
        // より低い閾値で音声検出
        const isSpeaking = level > VAD_SPEECH_THRESHOLD;
        setIsSpeechDetected(isSpeaking);
        
        // VADロジック
        const now = Date.now();
        
        if (isSpeaking) {
          // 発話中
          if (speechStartTimeRef.current === null) {
            speechStartTimeRef.current = now;
            console.log('[VAD] Speech started');
          }
          
          // 発話中の表示（バッファがあればそれを表示）
          if (!isProcessingRef.current) {
            const activeBuffer = activeBufferRef.current === 'A' ? bufferARef : bufferBRef;
            if (activeBuffer.current) {
              const speechDuration = Math.floor((now - speechStartTimeRef.current) / 1000);
              setInterimTranscript(`🔊 ${activeBuffer.current} (${speechDuration}秒)`);
            } else {
              const speechDuration = Math.floor((now - speechStartTimeRef.current) / 1000);
              setInterimTranscript(`🔊 聴いています... (${speechDuration}秒)`);
            }
          }
          
          silenceStartTimeRef.current = null;
          
          // VADタイムアウトをクリア
          if (vadTimeoutRef.current) {
            clearTimeout(vadTimeoutRef.current);
            vadTimeoutRef.current = null;
          }
          
          // バッファ無音タイマーもクリア（発話中はGemini送信しない）
          if (bufferSilenceTimerRef.current) {
            clearTimeout(bufferSilenceTimerRef.current);
            bufferSilenceTimerRef.current = null;
          }
          
          // 最大発話時間を超えたら強制送信
          if (speechStartTimeRef.current && (now - speechStartTimeRef.current) > VAD_MAX_SPEECH_DURATION) {
            console.log('[VAD] Max speech duration reached, forcing send');
            processAudio();
            speechStartTimeRef.current = now; // リセットして継続
          }
        } else {
          // 無音
          const activeBuffer = activeBufferRef.current === 'A' ? bufferARef : bufferBRef;
          if (speechStartTimeRef.current === null && !isProcessingRef.current) {
            // まだ発話が始まっていない
            if (activeBuffer.current) {
              setInterimTranscript(`💬 ${activeBuffer.current}`);
            } else {
              setInterimTranscript('🎤 音声を待機中...');
            }
          }
          if (speechStartTimeRef.current !== null) {
            // 発話後の無音
            if (silenceStartTimeRef.current === null) {
              silenceStartTimeRef.current = now;
            }
            
            const silenceDuration = now - silenceStartTimeRef.current;
            const speechDuration = now - speechStartTimeRef.current;
            
            // 無音中の表示
            if (silenceDuration > 100 && !isProcessingRef.current) {
              if (activeBuffer.current) {
                setInterimTranscript(`⏳ ${activeBuffer.current}...`);
              } else {
                setInterimTranscript(`⏳ 言葉の区切りを待機中... (${(silenceDuration/1000).toFixed(1)}秒)`);
              }
            }
            
            // 無音が一定時間続いたらWhisperに送信
            if (silenceDuration >= VAD_SILENCE_DURATION && speechDuration >= VAD_MIN_SPEECH_DURATION) {
              if (!isProcessingRef.current && !vadTimeoutRef.current) {
                vadTimeoutRef.current = setTimeout(() => {
                  console.log('[VAD] Silence detected after speech, sending audio');
                  processAudio();
                  speechStartTimeRef.current = null;
                  silenceStartTimeRef.current = null;
                  vadTimeoutRef.current = null;
                }, 50);
              }
            }
          }
        }
      });

      recorderRef.current = recorder;
      setState('listening');
      setProcessingStatus('解析中');

    } catch (e) {
      console.error('[Whisper] Failed to start:', e);
      setError('マイクの使用が許可されていません');
      setState('idle');
      setProcessingStatus('');
    }
  }, [isSupported, currentGain, processAudio]);

  const stopListening = useCallback(async () => {
    setState('stopping');
    setProcessingStatus('停止中...');

    // タイマーをクリア
    if (animationTimerRef.current) {
      clearTimeout(animationTimerRef.current);
      animationTimerRef.current = null;
    }
    if (bufferSilenceTimerRef.current) {
      clearTimeout(bufferSilenceTimerRef.current);
      bufferSilenceTimerRef.current = null;
    }
    if (vadTimeoutRef.current) {
      clearTimeout(vadTimeoutRef.current);
      vadTimeoutRef.current = null;
    }
    
    // 両方のバッファに残りがあればGeminiに送信
    const remainingText = (bufferARef.current.trim() + ' ' + bufferBRef.current.trim()).trim();
    if (remainingText && onBufferReadyRef.current) {
      console.log('[Whisper] Flushing remaining buffers on stop:', remainingText);
      onBufferReadyRef.current(remainingText);
    }
    
    speechStartTimeRef.current = null;
    silenceStartTimeRef.current = null;
    bufferARef.current = '';
    bufferBRef.current = '';
    activeBufferRef.current = 'A';
    displayedTextRef.current = '';
    targetTextRef.current = '';

    // 最後の音声を処理
    if (recorderRef.current) {
      const finalBlob = recorderRef.current.stop();
      
      // 無音でなく、十分なサイズがある場合のみ処理
      if (finalBlob && finalBlob.size > 1000 && maxAudioLevelRef.current >= silenceThreshold) {
        setState('processing');
        setInterimTranscript('最終処理中...');
        setProcessingStatus('最終処理中...');
        
        try {
          const result = await transcribeAudio(finalBlob, whisperPromptRef.current);
          if (result.text && result.text.trim() && !isHallucination(result.text.trim())) {
            const finalText = result.text.trim();
            
            // 会話欄に追加
            setTranscript((prev) => {
              return prev ? prev + '\n' + finalText : finalText;
            });
            
            // Geminiにも送信
            if (onBufferReadyRef.current) {
              onBufferReadyRef.current(finalText);
            }
          }
        } catch (e) {
          console.error('[Whisper] Final transcription error:', e);
        }
      }
      
      recorderRef.current = null;
    }

    setState('idle');
    setInterimTranscript('');
    setIsSpeechDetected(false);
    setAudioLevel(0);
    setProcessingStatus('');
    maxAudioLevelRef.current = 0;
    recentAudioLevelsRef.current = [];
  }, [silenceThreshold]);

  const clearTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
    pendingTextRef.current = '';
    bufferARef.current = '';
    bufferBRef.current = '';
    activeBufferRef.current = 'A';
    displayedTextRef.current = '';
    targetTextRef.current = '';
  }, []);

  // クリーンアップ
  useEffect(() => {
    return () => {
      if (vadTimeoutRef.current) {
        clearTimeout(vadTimeoutRef.current);
      }
      if (animationTimerRef.current) {
        clearTimeout(animationTimerRef.current);
      }
      if (bufferSilenceTimerRef.current) {
        clearTimeout(bufferSilenceTimerRef.current);
      }
      if (recorderRef.current) {
        recorderRef.current.stop();
      }
    };
  }, []);

  return {
    transcript,
    interimTranscript,
    state,
    isListening: state === 'listening' || state === 'processing',
    isSpeechDetected,
    isClipping,
    error,
    isSupported,
    audioLevel,
    currentGain,
    processingStatus,
    setGain,
    startListening,
    stopListening,
    clearTranscript,
  };
}
