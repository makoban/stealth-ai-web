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

function calculateMaxChars(): number {
  const realtimeElement = document.querySelector('.realtime-text');
  if (!realtimeElement) return 15;
  
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
  
  // リアルタイム表示用
  const displayTextRef = useRef<string>('');
  const typingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingQueueRef = useRef<string[]>([]);
  const isTypingRef = useRef<boolean>(false);
  const typingTickCountRef = useRef<number>(0); // デバッグ用カウンター
  
  const maxCharsRef = useRef<number>(15);
  
  // Whisper定期送信用
  const whisperIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const WHISPER_INTERVAL = 1500;
  
  // Gemini送信用
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

  const getScrolledText = useCallback((text: string) => {
    const maxChars = maxCharsRef.current;
    if (text.length <= maxChars) return text;
    return '...' + text.slice(-maxChars);
  }, []);

  // タイプライター処理
  const processTypingQueue = useCallback(() => {
    log('TYPING', `processTypingQueue called - isTyping: ${isTypingRef.current}, queueLength: ${typingQueueRef.current.length}`);
    
    if (isTypingRef.current) {
      log('TYPING', 'Already typing, skipping');
      return;
    }
    
    if (typingQueueRef.current.length === 0) {
      log('TYPING', 'Queue empty, nothing to process');
      return;
    }
    
    const nextText = typingQueueRef.current.shift()!;
    log('TYPING', `Starting to type: "${nextText}"`);
    isTypingRef.current = true;
    typingTickCountRef.current = 0;
    
    const startText = displayTextRef.current;
    const fullText = startText ? startText + ' ' + nextText : nextText;
    let charIndex = startText.length;
    
    log('TYPING', `startText: "${startText}", fullText: "${fullText}", startIndex: ${charIndex}`);
    
    // 既存タイマーをクリア
    if (typingTimerRef.current) {
      log('TYPING', 'Clearing existing timer');
      clearInterval(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    
    typingTimerRef.current = setInterval(() => {
      typingTickCountRef.current++;
      charIndex++;
      
      if (charIndex <= fullText.length) {
        displayTextRef.current = fullText.slice(0, charIndex);
        const scrolled = getScrolledText(displayTextRef.current);
        setInterimTranscript(`💬 ${scrolled}`);
        
        if (typingTickCountRef.current % 10 === 0) {
          log('TYPING', `Tick ${typingTickCountRef.current}: charIndex=${charIndex}/${fullText.length}, displayed="${displayTextRef.current.slice(-20)}"`);
        }
      }
      
      if (charIndex >= fullText.length) {
        log('TYPING', `Completed: "${fullText}" after ${typingTickCountRef.current} ticks`);
        if (typingTimerRef.current) {
          clearInterval(typingTimerRef.current);
          typingTimerRef.current = null;
        }
        isTypingRef.current = false;
        
        // 次のキューを処理（少し遅延を入れる）
        setTimeout(() => {
          log('TYPING', 'Checking next queue item');
          processTypingQueue();
        }, 10);
      }
    }, 50);
    
    log('TYPING', `Timer started: ${typingTimerRef.current}`);
  }, [getScrolledText]);

  const addToTypingQueue = useCallback((text: string) => {
    log('QUEUE', `Adding to queue: "${text}", current queue length: ${typingQueueRef.current.length}`);
    typingQueueRef.current.push(text);
    log('QUEUE', `Queue after add: [${typingQueueRef.current.map(t => `"${t}"`).join(', ')}]`);
    processTypingQueue();
  }, [processTypingQueue]);

  const flushGeminiBuffer = useCallback(() => {
    const buffer = geminiBufferRef.current.trim();
    log('GEMINI', `flushGeminiBuffer called - buffer: "${buffer.slice(0, 50)}..."`);
    
    if (buffer && onBufferReadyRef.current) {
      log('GEMINI', 'Sending to Gemini');
      onBufferReadyRef.current(buffer);
      
      geminiBufferRef.current = '';
      
      // リアルタイム表示をクリア
      log('GEMINI', `Clearing display - isTyping: ${isTypingRef.current}, timer: ${typingTimerRef.current}`);
      displayTextRef.current = '';
      typingQueueRef.current = [];
      if (typingTimerRef.current) {
        clearInterval(typingTimerRef.current);
        typingTimerRef.current = null;
      }
      isTypingRef.current = false;
      setInterimTranscript('🎤 次の音声を待機中...');
      log('GEMINI', 'Display cleared');
    }
  }, []);

  const resetGeminiTimer = useCallback(() => {
    log('TIMER', `resetGeminiTimer called - buffer: "${geminiBufferRef.current.slice(0, 30)}..."`);
    if (geminiTimerRef.current) {
      clearTimeout(geminiTimerRef.current);
      geminiTimerRef.current = null;
    }
    if (geminiBufferRef.current.trim()) {
      geminiTimerRef.current = setTimeout(() => {
        log('TIMER', 'Gemini timer fired');
        flushGeminiBuffer();
      }, GEMINI_FLUSH_DELAY);
      log('TIMER', `Gemini timer set for ${GEMINI_FLUSH_DELAY}ms`);
    }
  }, [flushGeminiBuffer]);

  const setGain = useCallback((value: number) => {
    setCurrentGain(value);
    if (recorderRef.current) {
      recorderRef.current.setGain(value);
    }
  }, []);

  const sendToWhisper = useCallback(async () => {
    if (!recorderRef.current || isProcessingRef.current || !recorderRef.current.isRecording()) {
      return;
    }

    const maxLevel = maxAudioLevelRef.current;
    log('WHISPER', `sendToWhisper - maxLevel: ${maxLevel.toFixed(3)}, threshold: ${silenceThreshold}`);
    
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
          
          geminiBufferRef.current = geminiBufferRef.current 
            ? geminiBufferRef.current + ' ' + newText 
            : newText;
          log('WHISPER', `Gemini buffer: "${geminiBufferRef.current.slice(0, 50)}..."`);
          
          addToTypingQueue(newText);
          
          setTranscript(prev => prev ? prev + '\n' + newText : newText);
          setProcessingStatus('認識成功');
          
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
  }, [silenceThreshold, addToTypingQueue, resetGeminiTimer]);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('音声録音はサポートされていません');
      return;
    }

    log('START', 'Starting listening...');
    setError(null);
    setState('starting');
    
    geminiBufferRef.current = '';
    displayTextRef.current = '';
    typingQueueRef.current = [];
    isTypingRef.current = false;
    maxAudioLevelRef.current = 0;
    lastSpeechTimeRef.current = Date.now();
    
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
          if (geminiTimerRef.current) {
            clearTimeout(geminiTimerRef.current);
            geminiTimerRef.current = null;
          }
        } else {
          const silenceDuration = Date.now() - lastSpeechTimeRef.current;
          if (silenceDuration >= GEMINI_FLUSH_DELAY && geminiBufferRef.current.trim() && !geminiTimerRef.current) {
            resetGeminiTimer();
          }
        }
        
        // リアルタイム表示更新
        if (!isTypingRef.current && !isProcessingRef.current) {
          if (isSpeaking) {
            if (displayTextRef.current) {
              setInterimTranscript(`🔊 ${getScrolledText(displayTextRef.current)}...`);
            } else {
              setInterimTranscript('🔊 聴いています...');
            }
          } else if (!displayTextRef.current) {
            setInterimTranscript('🎤 音声を待機中...');
          }
        }
      });

      recorderRef.current = recorder;
      setState('listening');
      setProcessingStatus('解析中');
      
      whisperIntervalRef.current = setInterval(() => {
        sendToWhisper();
      }, WHISPER_INTERVAL);
      
      log('START', 'Listening started');

    } catch (e) {
      log('START', `Error: ${e}`);
      setError('マイクの使用が許可されていません');
      setState('idle');
    }
  }, [isSupported, currentGain, sendToWhisper, resetGeminiTimer, getScrolledText]);

  const stopListening = useCallback(async () => {
    log('STOP', 'Stopping...');
    setState('stopping');

    if (typingTimerRef.current) {
      clearInterval(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    if (whisperIntervalRef.current) {
      clearInterval(whisperIntervalRef.current);
      whisperIntervalRef.current = null;
    }
    if (geminiTimerRef.current) {
      clearTimeout(geminiTimerRef.current);
      geminiTimerRef.current = null;
    }
    
    if (geminiBufferRef.current.trim() && onBufferReadyRef.current) {
      log('STOP', `Sending remaining buffer: "${geminiBufferRef.current.slice(0, 50)}..."`);
      onBufferReadyRef.current(geminiBufferRef.current.trim());
    }
    
    geminiBufferRef.current = '';
    displayTextRef.current = '';
    typingQueueRef.current = [];
    isTypingRef.current = false;

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
    typingQueueRef.current = [];
    isTypingRef.current = false;
  }, []);

  useEffect(() => {
    return () => {
      if (whisperIntervalRef.current) clearInterval(whisperIntervalRef.current);
      if (typingTimerRef.current) clearInterval(typingTimerRef.current);
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
