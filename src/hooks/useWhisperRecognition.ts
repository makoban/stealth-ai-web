import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioRecorder, transcribeAudio } from '../lib/whisper';

export type RecognitionState = 'idle' | 'starting' | 'listening' | 'processing' | 'stopping';

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

// 画面サイズから表示可能文字数を計算
function calculateMaxChars(): number {
  const realtimeElement = document.querySelector('.realtime-text');
  if (!realtimeElement) return 20;
  
  const computedStyle = window.getComputedStyle(realtimeElement);
  const width = realtimeElement.clientWidth;
  const paddingLeft = parseFloat(computedStyle.paddingLeft) || 0;
  const paddingRight = parseFloat(computedStyle.paddingRight) || 0;
  const availableWidth = width - paddingLeft - paddingRight - 30;
  const fontSize = parseFloat(computedStyle.fontSize) || 16;
  const maxChars = Math.floor((availableWidth / fontSize) * 0.8);
  
  return Math.max(10, maxChars);
}

export function useWhisperRecognition(options: UseWhisperRecognitionOptions = {}) {
  const {
    whisperPrompt = '',
    onBufferReady,
  } = options;

  const [transcript, setTranscript] = useState<string>('');
  const [interimTranscript, setInterimTranscript] = useState<string>('');
  const [state, setState] = useState<RecognitionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState<boolean>(false);
  const [isSpeechDetected, setIsSpeechDetected] = useState<boolean>(false);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [isClipping, setIsClipping] = useState<boolean>(false);
  const [currentGain, setCurrentGain] = useState<number>(50);
  const [processingStatus, setProcessingStatus] = useState<string>('');

  const recorderRef = useRef<AudioRecorder | null>(null);
  const isProcessingRef = useRef<boolean>(false);
  
  // リアルタイム表示用
  const displayTextRef = useRef<string>('');
  const maxCharsRef = useRef<number>(20);
  
  // VAD用
  const lastSpeechTimeRef = useRef<number>(0); // 0で初期化（開始直後の誤発火防止）
  const vadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasSpeechRef = useRef<boolean>(false); // 音声があったかどうか
  const VAD_SPEECH_THRESHOLD = 0.015;
  const VAD_SILENCE_DURATION = 400; // 0.4秒無音でWhisper送信
  
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

  // シンプル表示更新：新テキストを末尾に追加、maxChars超えたら先頭削除
  const updateDisplay = useCallback((newText: string) => {
    const combined = displayTextRef.current + newText;
    const maxChars = maxCharsRef.current;
    
    if (combined.length > maxChars) {
      displayTextRef.current = combined.slice(-maxChars);
    } else {
      displayTextRef.current = combined;
    }
    
    log('DISPLAY', `Updated: "${displayTextRef.current}" (${displayTextRef.current.length}/${maxChars})`);
    setInterimTranscript(`💬 ${displayTextRef.current}`);
  }, []);

  const setGain = useCallback((value: number) => {
    setCurrentGain(value);
    if (recorderRef.current) {
      recorderRef.current.setGain(value);
    }
  }, []);

  // VAD発火時にWhisper送信
  const sendToWhisper = useCallback(async () => {
    if (!recorderRef.current || isProcessingRef.current || !recorderRef.current.isRecording()) {
      log('VAD', 'Skipping - recorder not ready or processing');
      return;
    }

    const blob = recorderRef.current.getIntermediateBlob();
    
    if (!blob || blob.size < 1000) {
      log('VAD', `Blob too small: ${blob?.size || 0}`);
      return;
    }

    log('VAD', `Sending blob: ${blob.size} bytes`);
    isProcessingRef.current = true;
    setProcessingStatus('Whisper送信中...');

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
          
          // リアルタイム表示を更新
          updateDisplay(newText);
          
          // transcript更新
          setTranscript(prev => prev ? prev + '\n' + newText : newText);
          setProcessingStatus('認識成功');
          
          // Geminiに送信
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
  }, [updateDisplay]);

  // VAD処理
  const handleVAD = useCallback((level: number) => {
    const isSpeaking = level > VAD_SPEECH_THRESHOLD;
    setIsSpeechDetected(isSpeaking);
    
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
      // 無音
      // 音声があった後の無音のみ処理
      if (hasSpeechRef.current && lastSpeechTimeRef.current > 0) {
        const silenceDuration = Date.now() - lastSpeechTimeRef.current;
        
        if (silenceDuration >= VAD_SILENCE_DURATION && !vadTimerRef.current) {
          log('VAD', `Silence detected: ${silenceDuration}ms, triggering Whisper`);
          
          // VADタイマー発火
          vadTimerRef.current = setTimeout(() => {
            vadTimerRef.current = null;
            hasSpeechRef.current = false; // リセット
            sendToWhisper();
          }, 50); // 少し待ってから送信
        }
      }
    }
    
    // 状態表示（リアルタイム表示がない場合のみ）
    if (!displayTextRef.current) {
      if (isSpeaking) {
        setInterimTranscript('🔊 聴いています...');
      } else {
        setInterimTranscript('🎤 音声を待機中...');
      }
    }
  }, [sendToWhisper]);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('音声録音はサポートされていません');
      return;
    }

    log('START', 'Starting VAD listening...');
    setError(null);
    setState('starting');
    
    // 全てリセット
    displayTextRef.current = '';
    lastSpeechTimeRef.current = 0;
    hasSpeechRef.current = false;
    
    // 最大文字数を計算
    maxCharsRef.current = calculateMaxChars();
    log('START', `Max chars: ${maxCharsRef.current}`);

    try {
      const recorder = new AudioRecorder();
      recorder.setGain(currentGain);
      
      await recorder.start((level, clipping) => {
        setAudioLevel(level);
        setIsClipping(clipping);
        
        // VAD処理
        handleVAD(level);
      });

      recorderRef.current = recorder;
      setState('listening');
      setProcessingStatus('解析中');
      
      log('START', 'VAD listening started');

    } catch (e) {
      log('START', `Error: ${e}`);
      setError('マイクの使用が許可されていません');
      setState('idle');
    }
  }, [isSupported, currentGain, handleVAD]);

  const stopListening = useCallback(async () => {
    log('STOP', 'Stopping...');
    setState('stopping');

    // VADタイマークリア
    if (vadTimerRef.current) {
      clearTimeout(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    
    displayTextRef.current = '';

    if (recorderRef.current) {
      const finalBlob = recorderRef.current.stop();
      
      // 最終音声があれば送信
      if (finalBlob && finalBlob.size > 1000 && hasSpeechRef.current) {
        setState('processing');
        setInterimTranscript('最終処理中...');
        
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
    setInterimTranscript('');
    setIsSpeechDetected(false);
    setAudioLevel(0);
    setProcessingStatus('');
    hasSpeechRef.current = false;
    log('STOP', 'Stopped');
  }, []);

  const clearTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
    displayTextRef.current = '';
  }, []);

  useEffect(() => {
    return () => {
      if (vadTimerRef.current) clearTimeout(vadTimerRef.current);
      if (recorderRef.current) recorderRef.current.stop();
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
