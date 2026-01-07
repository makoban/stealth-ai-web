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
  
  // タイプライター用
  const typingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingIndexRef = useRef<number>(0);
  const typingTextRef = useRef<string>('');
  
  // シンプルバッファ
  const textBufferRef = useRef<string>('');
  const bufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const BUFFER_FLUSH_DELAY = 400; // 0.4秒無音でGemini送信
  
  const whisperPromptRef = useRef<string>(whisperPrompt);
  const onBufferReadyRef = useRef(onBufferReady);
  const maxAudioLevelRef = useRef<number>(0);
  
  // VAD用
  const speechStartTimeRef = useRef<number | null>(null);
  const silenceStartTimeRef = useRef<number | null>(null);
  const vadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const VAD_SILENCE_DURATION = 400;
  const VAD_MIN_SPEECH_DURATION = 300;
  const VAD_MAX_SPEECH_DURATION = 15000;
  const VAD_SPEECH_THRESHOLD = 0.015;

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

  // タイプライターアニメーション開始
  const startTyping = useCallback((text: string) => {
    // 既存のタイマーをクリア
    if (typingTimerRef.current) {
      clearInterval(typingTimerRef.current);
    }
    
    typingTextRef.current = text;
    typingIndexRef.current = 0;
    
    // 50msごとに1文字追加
    typingTimerRef.current = setInterval(() => {
      typingIndexRef.current++;
      const displayed = typingTextRef.current.slice(0, typingIndexRef.current);
      setInterimTranscript(`💬 ${displayed}`);
      
      // 全文字表示したらタイマー停止
      if (typingIndexRef.current >= typingTextRef.current.length) {
        if (typingTimerRef.current) {
          clearInterval(typingTimerRef.current);
          typingTimerRef.current = null;
        }
      }
    }, 50);
  }, []);

  // バッファをGeminiに送信
  const flushBuffer = useCallback(() => {
    const buffer = textBufferRef.current.trim();
    if (buffer && onBufferReadyRef.current) {
      console.log('[Whisper] Flushing buffer to Gemini:', buffer);
      onBufferReadyRef.current(buffer);
      textBufferRef.current = '';
      setInterimTranscript('🎤 次の音声を待機中...');
    }
  }, []);

  // バッファタイマーリセット
  const resetBufferTimer = useCallback(() => {
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
    }
    if (textBufferRef.current.trim()) {
      bufferTimerRef.current = setTimeout(flushBuffer, BUFFER_FLUSH_DELAY);
    }
  }, [flushBuffer]);

  const setGain = useCallback((value: number) => {
    setCurrentGain(value);
    if (recorderRef.current) {
      recorderRef.current.setGain(value);
    }
  }, []);

  // 音声処理（Whisper API送信）
  const processAudio = useCallback(async () => {
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
    setProcessingStatus('Whisper APIに送信中...');
    setInterimTranscript('☁️ クラウドで解析中...');

    try {
      const result = await transcribeAudio(blob, whisperPromptRef.current);
      
      if (result.text && result.text.trim()) {
        const newText = result.text.trim();
        
        if (isHallucination(newText)) {
          setProcessingStatus('ノイズ除去');
          setInterimTranscript('🎤 次の音声を待機中...');
        } else {
          console.log('[Whisper] Recognized:', newText);
          
          // バッファに追加
          if (textBufferRef.current) {
            textBufferRef.current += ' ' + newText;
          } else {
            textBufferRef.current = newText;
          }
          
          // タイプライター表示開始
          startTyping(textBufferRef.current);
          
          // バッファタイマーリセット
          resetBufferTimer();
          
          // transcript更新（会話欄用）
          setTranscript(prev => prev ? prev + '\n' + newText : newText);
          setProcessingStatus('認識成功');
        }
      } else {
        setProcessingStatus('音声なし');
        if (!textBufferRef.current) {
          setInterimTranscript('🎤 次の音声を待機中...');
        }
      }
    } catch (e) {
      console.error('[Whisper] Error:', e);
      setProcessingStatus('エラー');
    } finally {
      isProcessingRef.current = false;
    }
  }, [silenceThreshold, startTyping, resetBufferTimer]);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('音声録音はサポートされていません');
      return;
    }

    setError(null);
    setState('starting');
    textBufferRef.current = '';
    typingTextRef.current = '';
    typingIndexRef.current = 0;
    maxAudioLevelRef.current = 0;

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
        
        const now = Date.now();
        
        if (isSpeaking) {
          if (speechStartTimeRef.current === null) {
            speechStartTimeRef.current = now;
          }
          
          if (!isProcessingRef.current && !typingTimerRef.current) {
            const duration = Math.floor((now - speechStartTimeRef.current) / 1000);
            if (textBufferRef.current) {
              setInterimTranscript(`🔊 ${textBufferRef.current} (${duration}秒)`);
            } else {
              setInterimTranscript(`🔊 聴いています... (${duration}秒)`);
            }
          }
          
          silenceStartTimeRef.current = null;
          
          if (vadTimeoutRef.current) {
            clearTimeout(vadTimeoutRef.current);
            vadTimeoutRef.current = null;
          }
          if (bufferTimerRef.current) {
            clearTimeout(bufferTimerRef.current);
            bufferTimerRef.current = null;
          }
          
          if (speechStartTimeRef.current && (now - speechStartTimeRef.current) > VAD_MAX_SPEECH_DURATION) {
            processAudio();
            speechStartTimeRef.current = now;
          }
        } else {
          if (speechStartTimeRef.current === null && !isProcessingRef.current && !typingTimerRef.current) {
            if (textBufferRef.current) {
              setInterimTranscript(`💬 ${textBufferRef.current}`);
            } else {
              setInterimTranscript('🎤 音声を待機中...');
            }
          }
          
          if (speechStartTimeRef.current !== null) {
            if (silenceStartTimeRef.current === null) {
              silenceStartTimeRef.current = now;
            }
            
            const silenceDuration = now - silenceStartTimeRef.current;
            const speechDuration = now - speechStartTimeRef.current;
            
            if (silenceDuration >= VAD_SILENCE_DURATION && speechDuration >= VAD_MIN_SPEECH_DURATION) {
              if (!isProcessingRef.current && !vadTimeoutRef.current) {
                vadTimeoutRef.current = setTimeout(() => {
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
    }
  }, [isSupported, currentGain, processAudio]);

  const stopListening = useCallback(async () => {
    setState('stopping');

    // タイマークリア
    if (typingTimerRef.current) {
      clearInterval(typingTimerRef.current);
      typingTimerRef.current = null;
    }
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
    if (vadTimeoutRef.current) {
      clearTimeout(vadTimeoutRef.current);
      vadTimeoutRef.current = null;
    }
    
    // 残りバッファをGeminiに送信
    if (textBufferRef.current.trim() && onBufferReadyRef.current) {
      onBufferReadyRef.current(textBufferRef.current.trim());
    }
    
    speechStartTimeRef.current = null;
    silenceStartTimeRef.current = null;
    textBufferRef.current = '';

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
    textBufferRef.current = '';
    typingTextRef.current = '';
    typingIndexRef.current = 0;
  }, []);

  useEffect(() => {
    return () => {
      if (vadTimeoutRef.current) clearTimeout(vadTimeoutRef.current);
      if (typingTimerRef.current) clearInterval(typingTimerRef.current);
      if (bufferTimerRef.current) clearTimeout(bufferTimerRef.current);
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
