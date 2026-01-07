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
  const displayedTextRef = useRef<string>(''); // 現在表示中のテキスト
  
  // Whisper定期送信用（1.5秒ごと）
  const whisperIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const WHISPER_INTERVAL = 1500; // 1.5秒ごとにWhisper送信
  
  // Gemini送信用バッファ
  const geminiBufferRef = useRef<string>('');
  const geminiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const GEMINI_FLUSH_DELAY = 400; // 0.4秒無音でGemini送信
  
  // VAD用（Gemini送信トリガー）
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

  // 20文字スクロール表示用のヘルパー
  const MAX_DISPLAY_CHARS = 20;
  
  const getScrolledText = useCallback((text: string) => {
    if (text.length <= MAX_DISPLAY_CHARS) {
      return text;
    }
    // 20文字を超えたら最新の20文字を表示（左スクロール）
    return '...' + text.slice(-MAX_DISPLAY_CHARS);
  }, []);

  // タイプライターアニメーション（新しいテキストを追加、20文字スクロール）
  const appendTyping = useCallback((newText: string) => {
    // 既存のタイマーをクリア
    if (typingTimerRef.current) {
      clearInterval(typingTimerRef.current);
    }
    
    // 新しいテキストを追加
    const fullText = displayedTextRef.current ? displayedTextRef.current + ' ' + newText : newText;
    typingTextRef.current = fullText;
    typingIndexRef.current = displayedTextRef.current.length; // 既存部分はスキップ
    
    // 50msごとに1文字追加
    typingTimerRef.current = setInterval(() => {
      typingIndexRef.current++;
      const displayed = typingTextRef.current.slice(0, typingIndexRef.current);
      displayedTextRef.current = displayed;
      // 20文字スクロール表示
      setInterimTranscript(`💬 ${getScrolledText(displayed)}`);
      
      // 全文字表示したらタイマー停止
      if (typingIndexRef.current >= typingTextRef.current.length) {
        if (typingTimerRef.current) {
          clearInterval(typingTimerRef.current);
          typingTimerRef.current = null;
        }
      }
    }, 50);
  }, [getScrolledText]);

  // GeminiバッファをフラッシュしてGemini送信
  const flushGeminiBuffer = useCallback(() => {
    const buffer = geminiBufferRef.current.trim();
    if (buffer && onBufferReadyRef.current) {
      console.log('[Whisper] Flushing to Gemini:', buffer);
      onBufferReadyRef.current(buffer);
      
      // バッファとリアルタイム表示をクリア
      geminiBufferRef.current = '';
      displayedTextRef.current = '';
      typingTextRef.current = '';
      typingIndexRef.current = 0;
      setInterimTranscript('🎤 次の音声を待機中...');
    }
  }, []);

  // Geminiタイマーリセット（0.4秒無音でGemini送信）
  const resetGeminiTimer = useCallback(() => {
    if (geminiTimerRef.current) {
      clearTimeout(geminiTimerRef.current);
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

  // Whisper送信（定期的に呼ばれる）
  const sendToWhisper = useCallback(async () => {
    if (!recorderRef.current || isProcessingRef.current || !recorderRef.current.isRecording()) {
      return;
    }

    const maxLevel = maxAudioLevelRef.current;
    
    // 無音の場合はスキップ
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
          if (geminiBufferRef.current) {
            geminiBufferRef.current += ' ' + newText;
          } else {
            geminiBufferRef.current = newText;
          }
          
          // タイプライター表示（追加）
          appendTyping(newText);
          
          // transcript更新（会話欄用 - Gemini整形後に使用）
          setTranscript(prev => prev ? prev + '\n' + newText : newText);
          setProcessingStatus('認識成功');
          
          // 発話があったのでGeminiタイマーリセット
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
  }, [silenceThreshold, appendTyping, resetGeminiTimer]);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('音声録音はサポートされていません');
      return;
    }

    setError(null);
    setState('starting');
    geminiBufferRef.current = '';
    displayedTextRef.current = '';
    typingTextRef.current = '';
    typingIndexRef.current = 0;
    maxAudioLevelRef.current = 0;
    lastSpeechTimeRef.current = Date.now();

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
        if (!typingTimerRef.current && !isProcessingRef.current) {
          if (isSpeaking) {
            if (displayedTextRef.current) {
              // 20文字スクロール表示
              const scrolled = displayedTextRef.current.length > 20 
                ? '...' + displayedTextRef.current.slice(-20) 
                : displayedTextRef.current;
              setInterimTranscript(`🔊 ${scrolled}...`);
            } else {
              setInterimTranscript('🔊 聴いています...');
            }
          } else if (!displayedTextRef.current) {
            setInterimTranscript('🎤 音声を待機中...');
          }
        }
      });

      recorderRef.current = recorder;
      setState('listening');
      setProcessingStatus('解析中');
      
      // Whisper定期送信開始（1.5秒ごと）
      whisperIntervalRef.current = setInterval(() => {
        sendToWhisper();
      }, WHISPER_INTERVAL);

    } catch (e) {
      console.error('[Whisper] Failed to start:', e);
      setError('マイクの使用が許可されていません');
      setState('idle');
    }
  }, [isSupported, currentGain, sendToWhisper, resetGeminiTimer]);

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
    displayedTextRef.current = '';

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
    displayedTextRef.current = '';
    typingTextRef.current = '';
    typingIndexRef.current = 0;
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
