import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioRecorder, transcribeAudio } from '../lib/whisper';

export type RecognitionState = 'idle' | 'starting' | 'calibrating' | 'listening' | 'processing' | 'stopping';

// 状態アイコン（3文字表示）
export type StatusIcon = 'stopped' | 'calibrating' | 'silence' | 'speaking' | 'sending';

export interface UseWhisperRecognitionOptions {
  intervalMs?: number;
  silenceThreshold?: number;
  whisperPrompt?: string;
  onBufferReady?: (text: string) => void;
}

// デバッグモード
const DEBUG = true;
const log = (category: string, ...args: unknown[]) => {
  if (DEBUG) {
    const time = new Date().toISOString().slice(11, 23);
    console.log(`[${time}][${category}]`, ...args);
  }
};

// 幻覚フレーズ
const HALLUCINATION_EXACT = [
  'ご視聴ありがとうございました', 'ご視聴ありがとうございます',
  'ありがとうございました', 'ありがとうございます',
  'お疲れ様でした', 'おやすみなさい', 'さようなら',
  'Thank you for watching', 'Subscribe',
  '...', '。。。', '…',
];

const HALLUCINATION_PARTIAL = [
  'チャンネル登録', 'ご視聴', '視聴', '次回', '次の動画',
];

function isHallucination(text: string): boolean {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  
  for (const phrase of HALLUCINATION_EXACT) {
    if (normalized === phrase || lower === phrase.toLowerCase()) return true;
  }
  for (const phrase of HALLUCINATION_PARTIAL) {
    if (lower.includes(phrase.toLowerCase())) return true;
  }
  if (normalized.length <= 4) return true;
  if (/^(.)\1{3,}$/.test(normalized)) return true;
  
  return false;
}

// キャリブレーション設定
const CALIBRATION_DURATION = 2000; // 2秒間測定
const TARGET_NOISE_LEVEL = 0.3; // 目標ノイズレベル（キャリブレーション後）
const MIN_GAIN = 10;
const MAX_GAIN = 10000; // コンプレッサーで音割れ防止、上限なし
const DEFAULT_GAIN = 50;

export function useWhisperRecognition(options: UseWhisperRecognitionOptions = {}) {
  const {
    whisperPrompt = '',
    onBufferReady,
  } = options;

  const [transcript, setTranscript] = useState<string>('');
  const [state, setState] = useState<RecognitionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState<boolean>(false);
  const [isSpeechDetected, setIsSpeechDetected] = useState<boolean>(false);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [isClipping, setIsClipping] = useState<boolean>(false);
  const [currentGain, setCurrentGain] = useState<number>(DEFAULT_GAIN);
  const [processingStatus, setProcessingStatus] = useState<string>('');
  const [statusIcon, setStatusIcon] = useState<StatusIcon>('stopped');
  const [calibrationProgress, setCalibrationProgress] = useState<number>(0);
  const [isAgcEnabled, setIsAgcEnabled] = useState<boolean>(true); // AGCデフォルトON

  const recorderRef = useRef<AudioRecorder | null>(null);
  const isProcessingRef = useRef<boolean>(false);
  
  // キャリブレーション用
  const isCalibrating = useRef<boolean>(false);
  const calibrationLevels = useRef<number[]>([]);
  const calibratedGain = useRef<number>(DEFAULT_GAIN);
  const calibratedThreshold = useRef<number>(0.5);
  
  // AGC用
  const AGC_TARGET_LEVEL = 0.65; // 目標音量レベル
  const AGC_SMOOTHING = 0.1; // スムージング係数（0.1 = 緩やかに調整）
  const AGC_MIN_LEVEL = 0.02; // これ以下は無音とみなす
  const lastAgcUpdateRef = useRef<number>(0);
  const AGC_UPDATE_INTERVAL = 100; // 100msごとに更新
  
  // VAD用
  const lastSpeechTimeRef = useRef<number>(0);
  const vadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasSpeechRef = useRef<boolean>(false);
  const VAD_SPEECH_THRESHOLD_BASE = 0.5; // 基準閾値（キャリブレーションで調整）
  const VAD_SILENCE_DURATION = 200; // 0.2秒無音でWhisper送信
  
  // 最大蓄積時間用（連続音声対応）
  const recordingStartTimeRef = useRef<number>(0);
  const MAX_RECORDING_DURATION = 10000; // 10秒で強制送信
  const maxDurationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // デバッグ用統計
  const debugStatsRef = useRef({
    totalSamples: 0,
    speechSamples: 0,
    silenceSamples: 0,
    minLevel: 1,
    maxLevel: 0,
    lastLogTime: 0,
  });
  
  const whisperPromptRef = useRef<string>(whisperPrompt);
  const onBufferReadyRef = useRef(onBufferReady);

  useEffect(() => {
    onBufferReadyRef.current = onBufferReady;
  }, [onBufferReady]);

  useEffect(() => {
    whisperPromptRef.current = whisperPrompt;
  }, [whisperPrompt]);

  useEffect(() => {
    const supported = typeof navigator.mediaDevices !== 'undefined' && 
      typeof navigator.mediaDevices.getUserMedia === 'function';
    setIsSupported(supported);
    if (!supported) {
      setError('このブラウザは音声録音をサポートしていません。');
    }
  }, []);

  const setGain = useCallback((value: number) => {
    setCurrentGain(value);
    if (recorderRef.current) {
      recorderRef.current.setGain(value);
    }
  }, []);

  // Whisper送信（VAD発火時 or 最大時間到達時）
  const sendToWhisper = useCallback(async (reason: string) => {
    if (!recorderRef.current || isProcessingRef.current || !recorderRef.current.isRecording()) {
      log('WHISPER', `Skipping (${reason}) - recorder not ready or processing`);
      return;
    }

    const blob = recorderRef.current.getIntermediateBlob();
    
    if (!blob || blob.size < 1000) {
      log('WHISPER', `Skipping (${reason}) - blob too small: ${blob?.size || 0}`);
      return;
    }

    log('WHISPER', `Sending (${reason}): ${blob.size} bytes`);
    isProcessingRef.current = true;
    setProcessingStatus('Whisper送信中...');
    
    // 録音開始時間をリセット（次の10秒カウント用）
    recordingStartTimeRef.current = Date.now();

    try {
      const result = await transcribeAudio(blob, whisperPromptRef.current);
      log('WHISPER', `Result: "${result.text}"`);
      
      if (result.text && result.text.trim()) {
        const newText = result.text.trim();
        
        if (isHallucination(newText)) {
          log('WHISPER', 'Hallucination detected, ignoring');
          setProcessingStatus('ノイズ除去');
        } else {
          log('WHISPER', `Valid text: "${newText}"`);
          
          // transcript更新（重複防止のため、onBufferReadyのみで会話欄に追加）
          setTranscript(prev => prev ? prev + '\n' + newText : newText);
          setProcessingStatus('認識成功');
          
          // Geminiに送信（これが唯一の会話欄追加経路）
          if (onBufferReadyRef.current) {
            onBufferReadyRef.current(newText);
          }
        }
      } else {
        log('WHISPER', 'No text in result');
        setProcessingStatus('音声なし');
      }
    } catch (e) {
      log('WHISPER', `Error: ${e}`);
      setProcessingStatus('エラー');
    } finally {
      isProcessingRef.current = false;
    }
  }, []);

  // AGC処理（常時リアルタイムゲイン調整）
  const processAgc = useCallback((level: number) => {
    if (!isAgcEnabled) return;
    if (isCalibrating.current) return;
    
    const now = Date.now();
    if (now - lastAgcUpdateRef.current < AGC_UPDATE_INTERVAL) return;
    lastAgcUpdateRef.current = now;
    
    // 無音時は調整しない（ノイズでゲインが暴走するのを防止）
    if (level < AGC_MIN_LEVEL) return;
    
    // 目標レベルとの差分からゲインを調整
    const targetRatio = AGC_TARGET_LEVEL / level;
    const targetGain = calibratedGain.current * targetRatio;
    
    // スムージング（急激な変化を防止）
    const newGain = calibratedGain.current + (targetGain - calibratedGain.current) * AGC_SMOOTHING;
    
    // 範囲制限
    const clampedGain = Math.max(MIN_GAIN, Math.min(MAX_GAIN, Math.round(newGain)));
    
    // 変化がある場合のみ更新
    if (Math.abs(clampedGain - calibratedGain.current) >= 1) {
      calibratedGain.current = clampedGain;
      setCurrentGain(clampedGain);
      if (recorderRef.current) {
        recorderRef.current.setGain(clampedGain);
      }
      log('AGC', `level=${level.toFixed(3)} -> gain=${clampedGain}x (target=${AGC_TARGET_LEVEL})`);
    }
  }, [isAgcEnabled]);

  // VAD処理
  const handleVAD = useCallback((level: number) => {
    // キャリブレーション中はVAD処理をスキップ
    if (isCalibrating.current) {
      return;
    }
    
    // AGC処理
    processAgc(level);
    
    const threshold = calibratedThreshold.current;
    const isSpeaking = level > threshold;
    setIsSpeechDetected(isSpeaking);
    
    // 状態アイコンを更新
    if (isSpeaking) {
      setStatusIcon('speaking');
    } else {
      setStatusIcon('silence');
    }
    
    // デバッグ統計を更新
    const stats = debugStatsRef.current;
    stats.totalSamples++;
    if (isSpeaking) {
      stats.speechSamples++;
    } else {
      stats.silenceSamples++;
    }
    if (level < stats.minLevel) stats.minLevel = level;
    if (level > stats.maxLevel) stats.maxLevel = level;
    
    // 1秒ごとにデバッグログを出力
    const now = Date.now();
    if (now - stats.lastLogTime > 1000) {
      const speechRatio = stats.totalSamples > 0 ? (stats.speechSamples / stats.totalSamples * 100).toFixed(1) : '0';
      log('LEVEL_STATS', 
        `level=${level.toFixed(4)} | ` +
        `min=${stats.minLevel.toFixed(4)} max=${stats.maxLevel.toFixed(4)} | ` +
        `speech=${speechRatio}% (${stats.speechSamples}/${stats.totalSamples}) | ` +
        `threshold=${threshold.toFixed(4)} (calibrated) | ` +
        `gain=${calibratedGain.current}x | ` +
        `hasSpeech=${hasSpeechRef.current} | ` +
        `isSpeaking=${isSpeaking}`
      );
      // 統計リセット
      stats.totalSamples = 0;
      stats.speechSamples = 0;
      stats.silenceSamples = 0;
      stats.minLevel = 1;
      stats.maxLevel = 0;
      stats.lastLogTime = now;
    }
    
    if (isSpeaking) {
      // 音声検出
      hasSpeechRef.current = true;
      lastSpeechTimeRef.current = Date.now();
      
      // VADタイマーをクリア（話し中）
      if (vadTimerRef.current) {
        clearTimeout(vadTimerRef.current);
        vadTimerRef.current = null;
      }
    } else {
      // 無音検出
      // 音声があった後の無音のみ処理
      if (hasSpeechRef.current && lastSpeechTimeRef.current > 0) {
        const silenceDuration = Date.now() - lastSpeechTimeRef.current;
        
        // 無音が100ms以上続いたらログ出力（VAD発火前の状態確認用）
        if (silenceDuration >= 100 && silenceDuration < VAD_SILENCE_DURATION) {
          log('SILENCE_BUILDING', `${silenceDuration}ms / ${VAD_SILENCE_DURATION}ms needed`);
        }
        
        if (silenceDuration >= VAD_SILENCE_DURATION && !vadTimerRef.current) {
          log('VAD_TRIGGER', `Silence ${silenceDuration}ms >= ${VAD_SILENCE_DURATION}ms, triggering Whisper`);
          
          // 区切りアイコンを表示
          setStatusIcon('sending');
          
          // VADタイマー発火
          vadTimerRef.current = setTimeout(() => {
            vadTimerRef.current = null;
            hasSpeechRef.current = false;
            sendToWhisper('VAD');
          }, 50);
        }
      }
    }
  }, [sendToWhisper, processAgc]);

  // 自動キャリブレーション
  const runCalibration = useCallback(async (_recorder: AudioRecorder): Promise<{ gain: number; threshold: number }> => {
    log('CALIBRATION', 'Starting automatic calibration...');
    isCalibrating.current = true;
    calibrationLevels.current = [];
    setStatusIcon('calibrating');
    setProcessingStatus('キャリブレーション中...');
    
    return new Promise((resolve) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / CALIBRATION_DURATION, 1);
        setCalibrationProgress(progress);
        
        if (elapsed >= CALIBRATION_DURATION) {
          clearInterval(checkInterval);
          
          const levels = calibrationLevels.current;
          if (levels.length === 0) {
            log('CALIBRATION', 'No samples collected, using defaults');
            isCalibrating.current = false;
            resolve({ gain: DEFAULT_GAIN, threshold: VAD_SPEECH_THRESHOLD_BASE });
            return;
          }
          
          // 統計計算
          const sortedLevels = [...levels].sort((a, b) => a - b);
          const avgLevel = levels.reduce((a, b) => a + b, 0) / levels.length;
          const medianLevel = sortedLevels[Math.floor(sortedLevels.length / 2)];
          const maxLevel = sortedLevels[sortedLevels.length - 1];
          const p90Level = sortedLevels[Math.floor(sortedLevels.length * 0.9)];
          
          log('CALIBRATION', `Samples: ${levels.length}, Avg: ${avgLevel.toFixed(4)}, Median: ${medianLevel.toFixed(4)}, Max: ${maxLevel.toFixed(4)}, P90: ${p90Level.toFixed(4)}`);
          
          // ゲイン計算: 環境ノイズが目標レベルになるようにゲインを調整
          // 現在のゲインでの平均レベルから、目標レベルに必要なゲインを逆算
          let newGain = DEFAULT_GAIN;
          if (avgLevel > 0.01) {
            // 目標: 環境ノイズが0.3程度になるゲイン
            const gainRatio = TARGET_NOISE_LEVEL / avgLevel;
            newGain = Math.round(DEFAULT_GAIN * gainRatio);
            newGain = Math.max(MIN_GAIN, Math.min(MAX_GAIN, newGain));
          } else {
            // レベルが非常に低い場合は最大ゲイン
            newGain = MAX_GAIN;
          }
          
          // 閾値計算: 環境ノイズの上限 + マージン
          // P90を使用して外れ値を除外
          const noiseFloor = p90Level * (newGain / DEFAULT_GAIN); // 新ゲインでの予想ノイズレベル
          const threshold = Math.min(Math.max(noiseFloor + 0.15, 0.4), 0.7); // 0.4〜0.7の範囲
          
          log('CALIBRATION', `Result: Gain ${DEFAULT_GAIN}x -> ${newGain}x, Threshold: ${threshold.toFixed(4)}`);
          
          isCalibrating.current = false;
          setCalibrationProgress(0);
          resolve({ gain: newGain, threshold });
        }
      }, 100);
    });
  }, []);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('音声録音はサポートされていません');
      return;
    }

    log('START', 'Starting with automatic calibration...');
    setError(null);
    setState('calibrating');
    setStatusIcon('calibrating');
    
    // 全てリセット
    lastSpeechTimeRef.current = 0;
    hasSpeechRef.current = false;
    recordingStartTimeRef.current = Date.now();
    debugStatsRef.current = {
      totalSamples: 0,
      speechSamples: 0,
      silenceSamples: 0,
      minLevel: 1,
      maxLevel: 0,
      lastLogTime: Date.now(),
    };

    try {
      const recorder = new AudioRecorder();
      // キャリブレーション用に初期ゲインを設定
      recorder.setGain(DEFAULT_GAIN);
      log('START', `Initial gain set to: ${DEFAULT_GAIN}`);
      
      await recorder.start((level, clipping) => {
        setAudioLevel(level);
        setIsClipping(clipping);
        
        // キャリブレーション中はレベルを収集
        if (isCalibrating.current) {
          calibrationLevels.current.push(level);
        } else {
          // VAD処理
          handleVAD(level);
        }
      });

      recorderRef.current = recorder;
      
      // 自動キャリブレーション実行
      const { gain, threshold } = await runCalibration(recorder);
      
      // キャリブレーション結果を適用
      calibratedGain.current = gain;
      calibratedThreshold.current = threshold;
      setCurrentGain(gain);
      recorder.setGain(gain);
      
      log('START', `Calibration complete. Gain: ${gain}x, Threshold: ${threshold.toFixed(4)}`);
      setProcessingStatus(`ゲイン${gain}x 閾値${threshold.toFixed(2)}`);
      
      setState('listening');
      setStatusIcon('silence');
      
      // 最大蓄積時間チェック（1秒ごと）
      maxDurationTimerRef.current = setInterval(() => {
        if (hasSpeechRef.current && recordingStartTimeRef.current > 0) {
          const elapsed = Date.now() - recordingStartTimeRef.current;
          log('MAX_DURATION_CHECK', `elapsed=${elapsed}ms, hasSpeech=${hasSpeechRef.current}, isProcessing=${isProcessingRef.current}`);
          if (elapsed >= MAX_RECORDING_DURATION && !isProcessingRef.current) {
            log('MAX_DURATION', `${elapsed}ms elapsed, forcing Whisper send`);
            hasSpeechRef.current = false;
            sendToWhisper('MAX_DURATION');
          }
        }
      }, 1000);
      
      log('START', 'VAD listening started');

    } catch (e) {
      log('START', `Error: ${e}`);
      setError('マイクの使用が許可されていません');
      setState('idle');
      setStatusIcon('stopped');
    }
  }, [isSupported, handleVAD, runCalibration, sendToWhisper]);

  const stopListening = useCallback(async () => {
    log('STOP', 'Stopping...');
    setState('stopping');
    setStatusIcon('stopped');

    // タイマークリア
    if (vadTimerRef.current) {
      clearTimeout(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    if (maxDurationTimerRef.current) {
      clearInterval(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }

    if (recorderRef.current) {
      const finalBlob = recorderRef.current.stop();
      
      // 最終音声があれば送信
      if (finalBlob && finalBlob.size > 1000 && hasSpeechRef.current) {
        setState('processing');
        
        try {
          const result = await transcribeAudio(finalBlob, whisperPromptRef.current);
          if (result.text && result.text.trim() && !isHallucination(result.text.trim())) {
            const finalText = result.text.trim();
            setTranscript(prev => prev ? prev + '\n' + finalText : finalText);
            if (onBufferReadyRef.current) {
              onBufferReadyRef.current(finalText);
            }
          }
        } catch (e) {
          log('STOP', `Final error: ${e}`);
        }
      }
      
      recorderRef.current = null;
    }

    setState('idle');
    setIsSpeechDetected(false);
    setAudioLevel(0);
    setProcessingStatus('');
    hasSpeechRef.current = false;
    log('STOP', 'Stopped');
  }, []);

  const clearTranscript = useCallback(() => {
    setTranscript('');
  }, []);

  // リアルタイム自動ゲイン調整（現在の音量から0.65になるよう調整）
  const autoAdjustGain = useCallback(() => {
    const currentLevel = audioLevel;
    const targetLevel = 0.65;
    
    if (currentLevel < 0.01) {
      // 音量がほぼ0の場合は最大ゲインに
      log('AUTO_GAIN', `Level too low (${currentLevel.toFixed(4)}), setting max gain`);
      const newGain = MAX_GAIN;
      setCurrentGain(newGain);
      calibratedGain.current = newGain;
      if (recorderRef.current) {
        recorderRef.current.setGain(newGain);
      }
      setProcessingStatus(`自動調整: ${newGain}x`);
      return;
    }
    
    // 現在のゲインと音量から必要なゲインを計算
    // targetLevel / currentLevel * currentGain = newGain
    const gainRatio = targetLevel / currentLevel;
    let newGain = Math.round(currentGain * gainRatio);
    
    // 範囲制限
    newGain = Math.max(MIN_GAIN, Math.min(MAX_GAIN, newGain));
    
    log('AUTO_GAIN', `Current: level=${currentLevel.toFixed(4)}, gain=${currentGain}x -> New: gain=${newGain}x (target=${targetLevel})`);
    
    setCurrentGain(newGain);
    calibratedGain.current = newGain;
    if (recorderRef.current) {
      recorderRef.current.setGain(newGain);
    }
    setProcessingStatus(`自動調整: ${newGain}x`);
  }, [audioLevel, currentGain]);

  useEffect(() => {
    return () => {
      if (vadTimerRef.current) clearTimeout(vadTimerRef.current);
      if (maxDurationTimerRef.current) clearInterval(maxDurationTimerRef.current);
      if (recorderRef.current) recorderRef.current.stop();
    };
  }, []);

  return {
    transcript,
    state,
    isListening: state === 'listening' || state === 'processing',
    isCalibrating: state === 'calibrating',
    calibrationProgress,
    isSpeechDetected,
    isClipping,
    error,
    isSupported,
    audioLevel,
    currentGain,
    processingStatus,
    statusIcon,
    setGain,
    autoAdjustGain,
    isAgcEnabled,
    toggleAgc: () => setIsAgcEnabled(prev => !prev),
    startListening,
    stopListening,
    clearTranscript,
  };
}
