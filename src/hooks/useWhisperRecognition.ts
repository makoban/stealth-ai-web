import { useState, useCallback, useRef, useEffect } from 'react';
import { AudioRecorder, transcribeAudio, AudioLevelInfo, VadState } from '../lib/whisper';

export type RecognitionState = 'idle' | 'starting' | 'listening' | 'processing' | 'stopping';

// 状態アイコン（3文字表示）
export type StatusIcon = 'stopped' | 'silence' | 'speaking' | 'sending';

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

// 定数
const DEFAULT_GAIN = 50;
const VAD_SILENCE_DURATION = 150; // 0.15秒無音でWhisper送信（より敏感に）
const MAX_RECORDING_DURATION = 5000; // 5秒で強制送信（より細かく区切る）
const MIN_RECORDING_DURATION = 500; // 0.5秒未満の音声は送信しない（ノイズ対策）

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
  const [isAgcEnabled, setIsAgcEnabled] = useState<boolean>(true); // AGCデフォルトON
  const [noiseFloor, setNoiseFloor] = useState<number>(0.05);
  const [vadState, setVadState] = useState<VadState>('silence');

  const recorderRef = useRef<AudioRecorder | null>(null);
  const isProcessingRef = useRef<boolean>(false);
  
  // VAD用
  const lastSpeechTimeRef = useRef<number>(0);
  const vadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasSpeechRef = useRef<boolean>(false);
  
  // 最大蓄積時間用（連続音声対応）
  const recordingStartTimeRef = useRef<number>(0);
  const maxDurationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
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

    // 最小録音時間チェック（ノイズ対策）
    const elapsed = Date.now() - recordingStartTimeRef.current;
    if (elapsed < MIN_RECORDING_DURATION && reason === 'VAD') {
      log('WHISPER', `Skipping (${reason}) - too short: ${elapsed}ms < ${MIN_RECORDING_DURATION}ms`);
      return;
    }

    const blob = recorderRef.current.getIntermediateBlob();
    
    if (!blob || blob.size < 1000) {
      log('WHISPER', `Skipping (${reason}) - blob too small: ${blob?.size || 0}`);
      return;
    }

    log('WHISPER', `Sending (${reason}): ${blob.size} bytes, duration: ${elapsed}ms`);
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

  // AudioRecorderからのコールバック処理
  const handleAudioLevel = useCallback((info: AudioLevelInfo) => {
    // UI状態を更新
    setAudioLevel(info.level);
    setIsClipping(info.isClipping);
    setIsSpeechDetected(info.isSpeaking);
    setCurrentGain(info.currentGain);
    setNoiseFloor(info.noiseFloor);
    setVadState(info.vadState);
    
    // 状態アイコンを更新
    if (info.isSpeaking) {
      setStatusIcon('speaking');
    } else {
      setStatusIcon('silence');
    }
    
    // VAD状態に基づいてWhisper送信を制御
    if (info.isSpeaking) {
      // 音声検出中
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
  }, [sendToWhisper]);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('音声録音はサポートされていません');
      return;
    }

    log('START', 'Starting with VAD→AGC architecture...');
    setError(null);
    setState('starting');
    setStatusIcon('silence');
    
    // 全てリセット
    lastSpeechTimeRef.current = 0;
    hasSpeechRef.current = false;
    recordingStartTimeRef.current = Date.now();

    try {
      const recorder = new AudioRecorder();
      
      // AGC設定を適用
      recorder.setAgcEnabled(isAgcEnabled);
      
      await recorder.start(handleAudioLevel);

      recorderRef.current = recorder;
      
      setState('listening');
      setStatusIcon('silence');
      setProcessingStatus('VAD→AGC構造で動作中');
      
      // 最大蓄積時間チェック（1秒ごと）
      maxDurationTimerRef.current = setInterval(() => {
        if (hasSpeechRef.current && recordingStartTimeRef.current > 0) {
          const elapsed = Date.now() - recordingStartTimeRef.current;
          if (elapsed >= MAX_RECORDING_DURATION && !isProcessingRef.current) {
            log('MAX_DURATION', `${elapsed}ms elapsed, forcing Whisper send`);
            hasSpeechRef.current = false;
            sendToWhisper('MAX_DURATION');
          }
        }
      }, 1000);
      
      log('START', 'VAD→AGC listening started');

    } catch (e) {
      log('START', `Error: ${e}`);
      setError('マイクの使用が許可されていません');
      setState('idle');
      setStatusIcon('stopped');
    }
  }, [isSupported, handleAudioLevel, sendToWhisper, isAgcEnabled]);

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

  // AGCトグル
  const toggleAgc = useCallback(() => {
    const newValue = !isAgcEnabled;
    setIsAgcEnabled(newValue);
    if (recorderRef.current) {
      recorderRef.current.setAgcEnabled(newValue);
    }
    log('AGC_TOGGLE', `AGC: ${newValue ? 'ON' : 'OFF'}`);
  }, [isAgcEnabled]);

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
    noiseFloor,
    vadState,
    setGain,
    isAgcEnabled,
    toggleAgc,
    startListening,
    stopListening,
    clearTranscript,
  };
}
