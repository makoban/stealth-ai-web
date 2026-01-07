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
    silenceThreshold = 0.05,
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
  
  // リアルタイム表示用（シンプル方式）
  const displayTextRef = useRef<string>('');
  const maxCharsRef = useRef<number>(20);
  
  // Whisper定期送信用
  const whisperIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const WHISPER_INTERVAL = 1500;
  
  // Gemini送信用（リアルタイム表示とは独立）
  const geminiBufferRef = useRef<string>('');
  const geminiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const GEMINI_FLUSH_DELAY = 400;
  
  // VAD用
  const lastSpeechTimeRef = useRef<number>(Date.now());
  const VAD_SPEECH_THRESHOLD = 0.015;
  
  const whisperPromptRef = useRef<string>(whisperPrompt);
  const onBufferReadyRef = useRef(onBufferReady);
  const maxAudioLevelRef = useRef<number>(0);

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
      // 先頭を削除して最新maxChars文字を保持
      displayTextRef.current = combined.slice(-maxChars);
    } else {
      displayTextRef.current = combined;
    }
    
    log('DISPLAY', `Updated: "${displayTextRef.current}" (${displayTextRef.current.length}/${maxChars})`);
    setInterimTranscript(`💬 ${displayTextRef.current}`);
  }, []);

  // Gemini送信
  const flushGeminiBuffer = useCallback(() => {
    const buffer = geminiBufferRef.current.trim();
    log('GEMINI', `flushGeminiBuffer - buffer: "${buffer.slice(0, 50)}..."`);
    
    if (buffer && onBufferReadyRef.current) {
      log('GEMINI', 'Sending to Gemini');
      onBufferReadyRef.current(buffer);
      geminiBufferRef.current = '';
      
      // リアルタイム表示もクリア（次の発話用）
      displayTextRef.current = '';
      setInterimTranscript('🎤 次の音声を待機中...');
      log('GEMINI', 'Display cleared');
    }
  }, []);

  // Geminiタイマーリセット
  const resetGeminiTimer = useCallback(() => {
    if (geminiTimerRef.current) {
      clearTimeout(geminiTimerRef.current);
      geminiTimerRef.current = null;
    }
    if (geminiBufferRef.current.trim()) {
      geminiTimerRef.current = setTimeout(() => {
        log('TIMER', 'Gemini timer fired');
        flushGeminiBuffer();
      }, GEMINI_FLUSH_DELAY);
    }
  }, [flushGeminiBuffer]);

  const setGain = useCallback((value: number) => {
    setCurrentGain(value);
    if (recorderRef.current) {
      recorderRef.current.setGain(value);
    }
  }, []);

  // Whisper送信
  const sendToWhisper = useCallback(async () => {
    if (!recorderRef.current || isProcessingRef.current || !recorderRef.current.isRecording()) {
      return;
    }

    const maxLevel = maxAudioLevelRef.current;
    log('WHISPER', `sendToWhisper - maxLevel: ${maxLevel.toFixed(3)}`);
    
    if (maxLevel < silenceThreshold) {
      recorderRef.current.getIntermediateBlob();
      maxAudioLevelRef.current = 0;
      return;
    }

    const blob = recorderRef.current.getIntermediateBlob();
    maxAudioLevelRef.current = 0;
    
    if (!blob || blob.size < 1000) {
      log('WHISPER', `Blob too small: ${blob?.size || 0}`);
      return;
    }

    log('WHISPER', `Sending blob: ${blob.size} bytes`);
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
          
          // Geminiバッファに追加
          geminiBufferRef.current = geminiBufferRef.current 
            ? geminiBufferRef.current + ' ' + newText 
            : newText;
          
          // リアルタイム表示を更新（シンプル方式）
          updateDisplay(newText);
          
          // transcript更新
          setTranscript(prev => prev ? prev + '\n' + newText : newText);
          setProcessingStatus('認識成功');
          
          // Geminiタイマーリセット
          lastSpeechTimeRef.current = Date.now();
          resetGeminiTimer();
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
  }, [silenceThreshold, updateDisplay, resetGeminiTimer]);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('音声録音はサポートされていません');
      return;
    }

    log('START', 'Starting listening...');
    setError(null);
    setState('starting');
    
    // 全てリセット
    geminiBufferRef.current = '';
    displayTextRef.current = '';
    maxAudioLevelRef.current = 0;
    lastSpeechTimeRef.current = Date.now();
    
    // 最大文字数を計算
    maxCharsRef.current = calculateMaxChars();
    log('START', `Max chars: ${maxCharsRef.current}`);

    try {
      const recorder = new AudioRecorder();
      recorder.setGain(currentGain);
      
      await recorder.start((level, clipping) => {
        setAudioLevel(level);
        setIsClipping(clipping);
        if (level > maxAudioLevelRef.current) {
          maxAudioLevelRef.current = level;
        }
        
        const isSpeaking = level > VAD_SPEECH_THRESHOLD;
        setIsSpeechDetected(isSpeaking);
        
        if (isSpeaking) {
          lastSpeechTimeRef.current = Date.now();
          // 発話中はGeminiタイマーをクリア
          if (geminiTimerRef.current) {
            clearTimeout(geminiTimerRef.current);
            geminiTimerRef.current = null;
          }
        } else {
          // 無音が続いたらGeminiタイマー開始
          const silenceDuration = Date.now() - lastSpeechTimeRef.current;
          if (silenceDuration >= GEMINI_FLUSH_DELAY && geminiBufferRef.current.trim() && !geminiTimerRef.current) {
            resetGeminiTimer();
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
      });

      recorderRef.current = recorder;
      setState('listening');
      setProcessingStatus('解析中');
      
      // Whisper定期送信開始
      whisperIntervalRef.current = setInterval(() => {
        sendToWhisper();
      }, WHISPER_INTERVAL);
      
      log('START', 'Listening started');

    } catch (e) {
      log('START', `Error: ${e}`);
      setError('マイクの使用が許可されていません');
      setState('idle');
    }
  }, [isSupported, currentGain, sendToWhisper, resetGeminiTimer]);

  const stopListening = useCallback(async () => {
    log('STOP', 'Stopping...');
    setState('stopping');

    // タイマークリア
    if (whisperIntervalRef.current) {
      clearInterval(whisperIntervalRef.current);
      whisperIntervalRef.current = null;
    }
    if (geminiTimerRef.current) {
      clearTimeout(geminiTimerRef.current);
      geminiTimerRef.current = null;
    }
    
    // 残りバッファをGeminiに送信
    if (geminiBufferRef.current.trim() && onBufferReadyRef.current) {
      log('STOP', `Sending remaining buffer: "${geminiBufferRef.current.slice(0, 50)}..."`);
      onBufferReadyRef.current(geminiBufferRef.current.trim());
    }
    
    geminiBufferRef.current = '';
    displayTextRef.current = '';

    if (recorderRef.current) {
      const finalBlob = recorderRef.current.stop();
      
      if (finalBlob && finalBlob.size > 1000 && maxAudioLevelRef.current >= silenceThreshold) {
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
    maxAudioLevelRef.current = 0;
    log('STOP', 'Stopped');
  }, [silenceThreshold]);

  const clearTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
    geminiBufferRef.current = '';
    displayTextRef.current = '';
  }, []);

  useEffect(() => {
    return () => {
      if (whisperIntervalRef.current) clearInterval(whisperIntervalRef.current);
      if (geminiTimerRef.current) clearTimeout(geminiTimerRef.current);
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
