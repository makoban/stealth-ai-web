import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioRecorder, transcribeAudio } from '../lib/whisper';

export type RecognitionState = 'idle' | 'starting' | 'listening' | 'processing' | 'stopping';

// 状態アイコン
export type StatusIcon = 'stopped' | 'silence' | 'listening';

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
  const [currentGain, setCurrentGain] = useState<number>(50);
  const [processingStatus, setProcessingStatus] = useState<string>('');
  const [statusIcon, setStatusIcon] = useState<StatusIcon>('stopped');

  const recorderRef = useRef<AudioRecorder | null>(null);
  const isProcessingRef = useRef<boolean>(false);
  
  // VAD用
  const lastSpeechTimeRef = useRef<number>(0);
  const vadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasSpeechRef = useRef<boolean>(false);
  const VAD_SPEECH_THRESHOLD = 0.5;
  const VAD_SILENCE_DURATION = 400; // 0.4秒無音でWhisper送信
  
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

  // VAD処理
  const handleVAD = useCallback((level: number) => {
    const isSpeaking = level > VAD_SPEECH_THRESHOLD;
    setIsSpeechDetected(isSpeaking);
    
    // 状態アイコンを更新
    if (isSpeaking) {
      setStatusIcon('listening');
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
        `threshold=${VAD_SPEECH_THRESHOLD} | ` +
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
          
          // VADタイマー発火
          vadTimerRef.current = setTimeout(() => {
            vadTimerRef.current = null;
            hasSpeechRef.current = false;
            sendToWhisper('VAD');
          }, 50);
        }
      }
    }
  }, [sendToWhisper]);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('音声録音はサポートされていません');
      return;
    }

    log('START', 'Starting VAD listening...');
    log('START', `VAD_SPEECH_THRESHOLD=${VAD_SPEECH_THRESHOLD}, VAD_SILENCE_DURATION=${VAD_SILENCE_DURATION}ms, MAX_RECORDING_DURATION=${MAX_RECORDING_DURATION}ms`);
    setError(null);
    setState('starting');
    setStatusIcon('silence');
    
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
      recorder.setGain(currentGain);
      log('START', `Gain set to: ${currentGain}`);
      
      await recorder.start((level, clipping) => {
        setAudioLevel(level);
        setIsClipping(clipping);
        
        // VAD処理
        handleVAD(level);
      });

      recorderRef.current = recorder;
      setState('listening');
      setProcessingStatus('解析中');
      
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
  }, [isSupported, currentGain, handleVAD, sendToWhisper]);

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
    isSpeechDetected,
    isClipping,
    error,
    isSupported,
    audioLevel,
    currentGain,
    processingStatus,
    statusIcon,
    setGain,
    startListening,
    stopListening,
    clearTranscript,
  };
}
