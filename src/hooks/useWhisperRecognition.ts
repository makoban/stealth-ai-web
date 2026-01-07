import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioRecorder, transcribeAudio } from '../lib/whisper';

export type RecognitionState = 'idle' | 'starting' | 'listening' | 'processing' | 'stopping';

export interface UseWhisperRecognitionOptions {
  intervalMs?: number;
  silenceThreshold?: number;
  whisperPrompt?: string;
  onBufferReady?: (text: string) => void; // Gemini送信用コールバック
}

// 幻覚フレーズ（完全一致）
const HALLUCINATION_EXACT = [
  'ご視聴ありがとうございました', 'ご視聴ありがとうございます',
  'ありがとうございました', 'ありがとうございます',
  'お疲れ様でした', 'おやすみなさい', 'さようなら',
  'Thank you for watching', 'Subscribe',
  '...', '。。。', '…',
];

// 幻覚フレーズ（部分一致）
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

// 横幅とフォントサイズから表示可能文字数を計算
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
  
  // リアルタイム表示用（Geminiとは別管理）
  const displayTextRef = useRef<string>('');
  const typingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingQueueRef = useRef<string[]>([]); // タイプライター待ちキュー
  const isTypingRef = useRef<boolean>(false);
  
  // 動的な最大文字数
  const maxCharsRef = useRef<number>(15);
  
  // Whisper定期送信用
  const whisperIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const WHISPER_INTERVAL = 1500;
  
  // Gemini送信用（リアルタイム表示とは別管理）
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

  // スクロール表示
  const getScrolledText = useCallback((text: string) => {
    const maxChars = maxCharsRef.current;
    if (text.length <= maxChars) return text;
    return '...' + text.slice(-maxChars);
  }, []);

  // タイプライター処理（キューから1つずつ処理）
  const processTypingQueue = useCallback(() => {
    if (isTypingRef.current || typingQueueRef.current.length === 0) return;
    
    const nextText = typingQueueRef.current.shift()!;
    isTypingRef.current = true;
    
    // 既存テキストに追加
    const startText = displayTextRef.current;
    const fullText = startText ? startText + ' ' + nextText : nextText;
    let charIndex = startText.length;
    
    typingTimerRef.current = setInterval(() => {
      charIndex++;
      if (charIndex <= fullText.length) {
        displayTextRef.current = fullText.slice(0, charIndex);
        setInterimTranscript(`💬 ${getScrolledText(displayTextRef.current)}`);
      }
      
      if (charIndex >= fullText.length) {
        if (typingTimerRef.current) {
          clearInterval(typingTimerRef.current);
          typingTimerRef.current = null;
        }
        isTypingRef.current = false;
        // 次のキューを処理
        processTypingQueue();
      }
    }, 50);
  }, [getScrolledText]);

  // テキストをタイプライターキューに追加
  const addToTypingQueue = useCallback((text: string) => {
    typingQueueRef.current.push(text);
    processTypingQueue();
  }, [processTypingQueue]);

  // Gemini送信（リアルタイム表示とは独立）
  const flushGeminiBuffer = useCallback(() => {
    const buffer = geminiBufferRef.current.trim();
    if (buffer && onBufferReadyRef.current) {
      console.log('[Whisper] Sending to Gemini:', buffer);
      onBufferReadyRef.current(buffer);
      
      // Geminiバッファのみクリア（リアルタイム表示は維持）
      geminiBufferRef.current = '';
      
      // リアルタイム表示をクリア
      displayTextRef.current = '';
      typingQueueRef.current = [];
      if (typingTimerRef.current) {
        clearInterval(typingTimerRef.current);
        typingTimerRef.current = null;
      }
      isTypingRef.current = false;
      setInterimTranscript('🎤 次の音声を待機中...');
    }
  }, []);

  // Geminiタイマーリセット
  const resetGeminiTimer = useCallback(() => {
    if (geminiTimerRef.current) {
      clearTimeout(geminiTimerRef.current);
      geminiTimerRef.current = null;
    }
    if (geminiBufferRef.current.trim()) {
      geminiTimerRef.current = setTimeout(flushGeminiBuffer, GEMINI_FLUSH_DELAY);
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
    if (maxLevel < silenceThreshold) {
      recorderRef.current.getIntermediateBlob();
      maxAudioLevelRef.current = 0;
      return;
    }

    const blob = recorderRef.current.getIntermediateBlob();
    maxAudioLevelRef.current = 0;
    
    if (!blob || blob.size < 1000) return;

    isProcessingRef.current = true;
    setProcessingStatus('Whisper送信中...');

    try {
      const result = await transcribeAudio(blob, whisperPromptRef.current);
      
      if (result.text && result.text.trim()) {
        const newText = result.text.trim();
        
        if (isHallucination(newText)) {
          setProcessingStatus('ノイズ除去');
        } else {
          console.log('[Whisper] Recognized:', newText);
          
          // Geminiバッファに追加
          geminiBufferRef.current = geminiBufferRef.current 
            ? geminiBufferRef.current + ' ' + newText 
            : newText;
          
          // タイプライターキューに追加（リアルタイム表示用）
          addToTypingQueue(newText);
          
          // transcript更新
          setTranscript(prev => prev ? prev + '\n' + newText : newText);
          setProcessingStatus('認識成功');
          
          // Geminiタイマーリセット
          lastSpeechTimeRef.current = Date.now();
          resetGeminiTimer();
        }
      } else {
        setProcessingStatus('音声なし');
      }
    } catch (e) {
      console.error('[Whisper] Error:', e);
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

    setError(null);
    setState('starting');
    
    // 全てリセット
    geminiBufferRef.current = '';
    displayTextRef.current = '';
    typingQueueRef.current = [];
    isTypingRef.current = false;
    maxAudioLevelRef.current = 0;
    lastSpeechTimeRef.current = Date.now();
    
    // 最大文字数を計算
    maxCharsRef.current = calculateMaxChars();
    console.log('[Whisper] Max display chars:', maxCharsRef.current);

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
        
        // リアルタイム表示更新（タイプライター中でなければ）
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
      
      // Whisper定期送信開始
      whisperIntervalRef.current = setInterval(() => {
        sendToWhisper();
      }, WHISPER_INTERVAL);

    } catch (e) {
      console.error('[Whisper] Failed to start:', e);
      setError('マイクの使用が許可されていません');
      setState('idle');
    }
  }, [isSupported, currentGain, sendToWhisper, resetGeminiTimer, getScrolledText]);

  const stopListening = useCallback(async () => {
    setState('stopping');

    // タイマークリア
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
    
    // 残りバッファをGeminiに送信
    if (geminiBufferRef.current.trim() && onBufferReadyRef.current) {
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
          console.error('[Whisper] Final error:', e);
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
