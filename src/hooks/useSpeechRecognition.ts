import { useState, useEffect, useRef, useCallback } from 'react';

export type RecognitionState = 'idle' | 'starting' | 'listening' | 'stopping' | 'reconnecting';
export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onaudiostart: (() => void) | null;
  onnomatch: (() => void) | null;
  onsoundstart: (() => void) | null;
  onsoundend: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

const createSpeechRecognition = (): SpeechRecognition | null => {
  if (typeof window === 'undefined') return null;
  const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionClass) return null;
  return new SpeechRecognitionClass();
};

// 最大再試行回数
const MAX_RETRY_COUNT = 30;
// ヘルスチェック間隔（ミリ秒）- 非常に頻繁に
const HEALTH_CHECK_INTERVAL = 500;
// 無反応とみなす時間（ミリ秒）- 非常に短く
const INACTIVITY_THRESHOLD = 1500;

export function useSpeechRecognition() {
  const [transcript, setTranscript] = useState<string>('');
  const [interimTranscript, setInterimTranscript] = useState<string>('');
  const [allCandidates, setAllCandidates] = useState<string[]>([]);
  const [state, setState] = useState<RecognitionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState<boolean>(false);
  const [isSpeechDetected, setIsSpeechDetected] = useState<boolean>(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [audioLevel, setAudioLevel] = useState<number>(0);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const shouldRestartRef = useRef(false);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const healthCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryCountRef = useRef<number>(0);
  const lastActivityRef = useRef<number>(Date.now());
  const isRestartingRef = useRef<boolean>(false);
  
  // AudioContext関連
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // サポート確認
  useEffect(() => {
    const supported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    setIsSupported(supported);
    if (!supported) {
      setError('このブラウザは音声認識をサポートしていません。Chrome、Safari、Edgeをお試しください。');
    }
  }, []);

  // 音声レベルを監視
  const startAudioMonitoring = useCallback(async () => {
    try {
      // マイクアクセスを取得
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } 
      });
      mediaStreamRef.current = stream;

      // AudioContextを作成
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioContext;

      // マイク入力をソースとして接続
      const source = audioContext.createMediaStreamSource(stream);
      
      // アナライザーを作成
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      analyserRef.current = analyser;

      // ゲインノード（音量増幅）を作成
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 3.0; // 3倍に増幅

      // 接続: source -> gain -> analyser
      source.connect(gainNode);
      gainNode.connect(analyser);
      // 注意: analyserをdestinationに接続するとフィードバックが起きるので接続しない

      // 音声レベルを監視
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      
      const updateLevel = () => {
        if (!analyserRef.current) return;
        
        analyserRef.current.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        const normalizedLevel = Math.min(average / 128, 1);
        setAudioLevel(normalizedLevel);
        
        // 音声が検出されたらフラグを立てる
        if (normalizedLevel > 0.05) {
          setIsSpeechDetected(true);
          lastActivityRef.current = Date.now();
        }
        
        animationFrameRef.current = requestAnimationFrame(updateLevel);
      };
      
      updateLevel();
      console.log('[Audio] Monitoring started with gain amplification');
    } catch (e) {
      console.error('[Audio] Failed to start monitoring:', e);
    }
  }, []);

  // 音声監視を停止
  const stopAudioMonitoring = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    analyserRef.current = null;
    setAudioLevel(0);
  }, []);

  // 音声認識を開始する関数
  const startRecognitionInstance = useCallback(() => {
    if (!shouldRestartRef.current || isRestartingRef.current) {
      return;
    }

    isRestartingRef.current = true;
    setConnectionStatus('reconnecting');

    // 既存の認識を確実に停止
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch (e) {
        // 無視
      }
      recognitionRef.current = null;
    }

    // 即座に再起動
    restartTimeoutRef.current = setTimeout(() => {
      if (!shouldRestartRef.current) {
        isRestartingRef.current = false;
        return;
      }

      try {
        const recognition = createSpeechRecognition();
        if (!recognition) {
          console.error('Failed to create speech recognition');
          isRestartingRef.current = false;
          setConnectionStatus('disconnected');
          return;
        }

        // 設定 - 最大感度
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'ja-JP';
        recognition.maxAlternatives = 10; // 最大候補数

        // イベントハンドラ設定
        recognition.onstart = () => {
          console.log('[Speech] Recognition started');
          setState('listening');
          setConnectionStatus('connected');
          setError(null);
          retryCountRef.current = 0;
          lastActivityRef.current = Date.now();
          isRestartingRef.current = false;
        };

        recognition.onaudiostart = () => {
          lastActivityRef.current = Date.now();
        };

        recognition.onsoundstart = () => {
          setIsSpeechDetected(true);
          lastActivityRef.current = Date.now();
        };

        recognition.onspeechstart = () => {
          setIsSpeechDetected(true);
          lastActivityRef.current = Date.now();
        };

        recognition.onspeechend = () => {
          lastActivityRef.current = Date.now();
        };

        recognition.onsoundend = () => {
          lastActivityRef.current = Date.now();
        };

        recognition.onresult = (event: SpeechRecognitionEvent) => {
          lastActivityRef.current = Date.now();
          setIsSpeechDetected(true);

          let finalText = '';
          let interimText = '';
          const candidates: string[] = [];

          // 全ての結果を処理
          for (let i = 0; i < event.results.length; i++) {
            const result = event.results[i];
            
            // 全ての候補を収集
            for (let j = 0; j < result.length; j++) {
              const alt = result[j];
              if (alt.transcript.trim()) {
                candidates.push(`${alt.transcript} (${((alt.confidence || 0) * 100).toFixed(0)}%)`);
              }
            }

            // 最も信頼度の高い候補を選択
            let bestTranscript = result[0].transcript;
            let bestConfidence = result[0].confidence || 0;

            for (let j = 1; j < result.length; j++) {
              const alt = result[j];
              if (alt.confidence && alt.confidence > bestConfidence) {
                bestTranscript = alt.transcript;
                bestConfidence = alt.confidence;
              }
            }

            if (result.isFinal) {
              finalText += bestTranscript;
            } else {
              interimText += bestTranscript;
            }
          }

          // 全候補を更新
          if (candidates.length > 0) {
            setAllCandidates(candidates.slice(0, 5));
          }

          // 暫定テキストを更新（リアルタイム表示用）
          setInterimTranscript(interimText);

          // 確定テキストがあれば追加
          if (finalText && finalText.trim()) {
            const trimmedFinal = finalText.trim();
            console.log('[Speech] Final:', trimmedFinal);
            setTranscript(prev => prev ? prev + '\n' + trimmedFinal : trimmedFinal);
          }
        };

        recognition.onnomatch = () => {
          console.log('[Speech] No match');
          lastActivityRef.current = Date.now();
        };

        recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
          console.error('[Speech] Error:', event.error);
          lastActivityRef.current = Date.now();

          // no-speechは正常 - 継続
          if (event.error === 'no-speech') {
            setIsSpeechDetected(false);
            return;
          }

          // abortedは手動停止
          if (event.error === 'aborted') {
            isRestartingRef.current = false;
            return;
          }

          // ネットワークエラー
          if (event.error === 'network') {
            retryCountRef.current++;
            if (retryCountRef.current >= MAX_RETRY_COUNT) {
              setError('ネットワークエラーが続いています');
              shouldRestartRef.current = false;
              setConnectionStatus('disconnected');
            }
            isRestartingRef.current = false;
            return;
          }

          // マイク許可エラー
          if (event.error === 'not-allowed') {
            setError('マイクの使用が許可されていません');
            shouldRestartRef.current = false;
            setConnectionStatus('disconnected');
            isRestartingRef.current = false;
            return;
          }

          if (event.error === 'audio-capture') {
            setError('マイクが見つかりません');
            shouldRestartRef.current = false;
            setConnectionStatus('disconnected');
            isRestartingRef.current = false;
            return;
          }

          // その他のエラーは再試行
          retryCountRef.current++;
          if (retryCountRef.current >= MAX_RETRY_COUNT) {
            setError('音声認識エラーが続いています');
            shouldRestartRef.current = false;
            setConnectionStatus('disconnected');
          }
          isRestartingRef.current = false;
        };

        recognition.onend = () => {
          console.log('[Speech] Recognition ended');
          lastActivityRef.current = Date.now();

          if (shouldRestartRef.current && !isRestartingRef.current) {
            // 即座に再起動
            startRecognitionInstance();
          } else if (!shouldRestartRef.current) {
            setState('idle');
            setConnectionStatus('disconnected');
            setInterimTranscript('');
          }
        };

        recognitionRef.current = recognition;
        recognition.start();
        console.log('[Speech] Recognition start() called');
      } catch (e) {
        console.error('[Speech] Failed to start:', e);
        isRestartingRef.current = false;
        retryCountRef.current++;

        if (shouldRestartRef.current && retryCountRef.current < MAX_RETRY_COUNT) {
          setTimeout(() => startRecognitionInstance(), 50);
        } else {
          setConnectionStatus('disconnected');
          setError('音声認識の開始に失敗しました');
        }
      }
    }, 0);
  }, []);

  // ヘルスチェック - 非常に頻繁に
  useEffect(() => {
    if (state === 'listening' && shouldRestartRef.current) {
      healthCheckIntervalRef.current = setInterval(() => {
        const timeSinceLastActivity = Date.now() - lastActivityRef.current;

        if (timeSinceLastActivity > INACTIVITY_THRESHOLD && !isRestartingRef.current) {
          console.log('[Speech] Health check: restarting');

          if (recognitionRef.current) {
            try {
              recognitionRef.current.abort();
            } catch (e) {
              // 無視
            }
          }
        }
      }, HEALTH_CHECK_INTERVAL);

      return () => {
        if (healthCheckIntervalRef.current) {
          clearInterval(healthCheckIntervalRef.current);
          healthCheckIntervalRef.current = null;
        }
      };
    }
  }, [state]);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('音声認識はサポートされていません');
      return;
    }

    console.log('[Speech] startListening called');
    setError(null);
    setState('starting');
    shouldRestartRef.current = true;
    retryCountRef.current = 0;
    lastActivityRef.current = Date.now();

    // 音声監視を開始
    await startAudioMonitoring();

    // 既存の認識を停止
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch (e) {
        // 無視
      }
      recognitionRef.current = null;
    }

    // タイムアウトをクリア
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }

    // 開始
    isRestartingRef.current = false;
    startRecognitionInstance();
  }, [isSupported, startRecognitionInstance, startAudioMonitoring]);

  const stopListening = useCallback(async () => {
    console.log('[Speech] stopListening called');
    setState('stopping');
    shouldRestartRef.current = false;
    isRestartingRef.current = false;

    // 音声監視を停止
    stopAudioMonitoring();

    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }

    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
      healthCheckIntervalRef.current = null;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        // 無視
      }
      recognitionRef.current = null;
    }

    setState('idle');
    setConnectionStatus('disconnected');
    setInterimTranscript('');
    setIsSpeechDetected(false);
  }, [stopAudioMonitoring]);

  const clearTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
    setAllCandidates([]);
  }, []);

  // クリーンアップ
  useEffect(() => {
    return () => {
      shouldRestartRef.current = false;
      isRestartingRef.current = false;
      stopAudioMonitoring();

      if (restartTimeoutRef.current) {
        clearTimeout(restartTimeoutRef.current);
      }
      if (healthCheckIntervalRef.current) {
        clearInterval(healthCheckIntervalRef.current);
      }
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch (e) {
          // 無視
        }
      }
    };
  }, [stopAudioMonitoring]);

  return {
    transcript,
    interimTranscript,
    allCandidates,
    state,
    isListening: state === 'listening' || state === 'reconnecting',
    isSpeechDetected,
    error,
    isSupported,
    connectionStatus,
    audioLevel,
    startListening,
    stopListening,
    clearTranscript,
  };
}
