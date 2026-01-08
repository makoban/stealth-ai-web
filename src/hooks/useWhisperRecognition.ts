import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioRecorder, transcribeAudio } from '../lib/whisper';

export type RecognitionState = 'idle' | 'starting' | 'listening' | 'processing' | 'stopping';

export interface UseWhisperRecognitionOptions {
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
  
  // ===== リアルタイム用Whisper① =====
  const realtimeProcessingRef = useRef<boolean>(false);
  const displayTextRef = useRef<string>('');
  const maxCharsRef = useRef<number>(20);
  const realtimeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const realtimeAudioLevelRef = useRef<number>(0);
  const REALTIME_INTERVAL = 1500; // 1.5秒固定
  
  // ===== 会話用Whisper② =====
  const conversationProcessingRef = useRef<boolean>(false);
  const geminiBufferRef = useRef<string>('');
  const lastSpeechTimeRef = useRef<number>(Date.now());
  const vadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const VAD_SPEECH_THRESHOLD = 0.015;
  const VAD_SILENCE_DURATION = 400; // 0.4秒
  
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

  // ===== リアルタイム表示更新 =====
  const updateDisplay = useCallback((newText: string) => {
    const combined = displayTextRef.current + newText;
    const maxChars = maxCharsRef.current;
    
    if (combined.length > maxChars) {
      displayTextRef.current = combined.slice(-maxChars);
    } else {
      displayTextRef.current = combined;
    }
    
    log('REALTIME', `Display: "${displayTextRef.current}" (${displayTextRef.current.length}/${maxChars})`);
    setInterimTranscript(`💬 ${displayTextRef.current}`);
  }, []);

  // ===== Whisper①: リアルタイム用（1.5秒固定） =====
  // 表示用バッファを取得してクリア（会話用バッファは別管理）
  const sendRealtimeWhisper = useCallback(async () => {
    if (!recorderRef.current || realtimeProcessingRef.current || !recorderRef.current.isRecording()) {
      return;
    }

    const maxLevel = realtimeAudioLevelRef.current;
    realtimeAudioLevelRef.current = 0;
    
    // 表示用バッファを取得（クリアされる）
    const blob = recorderRef.current.getRealtimeBlob();
    
    // バンドパスフィルタ後の音声レベルで判定（人の声がない場合は送信しない）
    if (maxLevel < silenceThreshold) {
      log('REALTIME', `No voice detected (level: ${maxLevel.toFixed(3)}), skipping`);
      return;
    }

    // blobは既に取得済み
    
    if (!blob || blob.size < 1000) {
      return;
    }

    log('REALTIME', `Sending to Whisper①: ${blob.size} bytes, level: ${maxLevel.toFixed(3)}`);
    realtimeProcessingRef.current = true;

    try {
      const result = await transcribeAudio(blob, whisperPromptRef.current);
      
      if (result.text && result.text.trim() && !isHallucination(result.text.trim())) {
        const newText = result.text.trim();
        log('REALTIME', `Result: "${newText}"`);
        updateDisplay(newText);
      }
    } catch (e) {
      log('REALTIME', `Error: ${e}`);
    } finally {
      realtimeProcessingRef.current = false;
    }
  }, [silenceThreshold, updateDisplay]);

  // ===== Whisper②: 会話用（VAD 0.4秒） =====
  const sendConversationWhisper = useCallback(async (audioBlob: Blob) => {
    if (conversationProcessingRef.current) {
      log('CONVERSATION', 'Already processing, queuing...');
      return;
    }

    log('CONVERSATION', `Sending to Whisper②: ${audioBlob.size} bytes`);
    conversationProcessingRef.current = true;
    setProcessingStatus('会話解析中...');

    try {
      const result = await transcribeAudio(audioBlob, whisperPromptRef.current);
      
      if (result.text && result.text.trim() && !isHallucination(result.text.trim())) {
        const newText = result.text.trim();
        log('CONVERSATION', `Result: "${newText}"`);
        
        // Geminiバッファに追加
        geminiBufferRef.current = geminiBufferRef.current 
          ? geminiBufferRef.current + ' ' + newText 
          : newText;
        
        // transcript更新
        setTranscript(prev => prev ? prev + '\n' + newText : newText);
        setProcessingStatus('認識成功');
        
        // Geminiに送信
        if (onBufferReadyRef.current && geminiBufferRef.current.trim()) {
          log('CONVERSATION', `Sending to Gemini: "${geminiBufferRef.current.slice(0, 50)}..."`);
          onBufferReadyRef.current(geminiBufferRef.current.trim());
          geminiBufferRef.current = '';
        }
      } else {
        log('CONVERSATION', 'No valid text');
        setProcessingStatus('音声なし');
      }
    } catch (e) {
      log('CONVERSATION', `Error: ${e}`);
      setProcessingStatus('エラー');
    } finally {
      conversationProcessingRef.current = false;
    }
  }, []);

  // ===== VAD処理 =====
  const handleVAD = useCallback((level: number) => {
    const isSpeaking = level > VAD_SPEECH_THRESHOLD;
    setIsSpeechDetected(isSpeaking);
    
    if (isSpeaking) {
      // 音声検出時のログ（頻度を減らすため条件付き）
      if (!lastSpeechTimeRef.current || Date.now() - lastSpeechTimeRef.current > 1000) {
        log('VAD', `Speech detected, level: ${level.toFixed(3)}`);
      }
      lastSpeechTimeRef.current = Date.now();
      
      // VADタイマーをクリア（話し中）
      if (vadTimerRef.current) {
        clearTimeout(vadTimerRef.current);
        vadTimerRef.current = null;
      }
    } else {
      // 無音が続いたらVADタイマー開始
      const silenceDuration = Date.now() - lastSpeechTimeRef.current;
      
      // デバッグ: 無音時の状態を確認（頻度を減らす）
      if (silenceDuration > 100 && silenceDuration < 600 && !vadTimerRef.current) {
        log('VAD', `Silence check: duration=${silenceDuration}ms, threshold=${VAD_SILENCE_DURATION}ms, timer=${!!vadTimerRef.current}, recorder=${!!recorderRef.current}`);
      }
      
      if (silenceDuration >= VAD_SILENCE_DURATION && !vadTimerRef.current && recorderRef.current) {
        log('VAD', `Silence duration: ${silenceDuration}ms, starting timer`);
        vadTimerRef.current = setTimeout(() => {
          vadTimerRef.current = null;
          
          // VAD終了: 会話用Whisper②に送信
          if (recorderRef.current && recorderRef.current.isRecording()) {
            log('VAD', 'Getting conversation blob...');
            const blob = recorderRef.current.getConversationBlob();
            log('VAD', `Blob size: ${blob?.size || 0} bytes`);
            if (blob && blob.size > 1000) {
              log('VAD', `Silence detected (${silenceDuration}ms), sending to Whisper②`);
              sendConversationWhisper(blob);
            } else {
              log('VAD', 'Blob too small or null, skipping');
            }
          } else {
            log('VAD', 'Recorder not recording, skipping');
          }
        }, 100); // 少し待ってから送信
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
  }, [sendConversationWhisper]);

  const setGain = useCallback((value: number) => {
    setCurrentGain(value);
    if (recorderRef.current) {
      recorderRef.current.setGain(value);
    }
  }, []);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('音声録音はサポートされていません');
      return;
    }

    log('START', 'Starting dual Whisper listening...');
    setError(null);
    setState('starting');
    
    // 全てリセット
    geminiBufferRef.current = '';
    displayTextRef.current = '';
    realtimeAudioLevelRef.current = 0;
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
        
        // リアルタイム用の最大レベルを記録
        if (level > realtimeAudioLevelRef.current) {
          realtimeAudioLevelRef.current = level;
        }
        
        // VAD処理
        handleVAD(level);
      });

      recorderRef.current = recorder;
      setState('listening');
      setProcessingStatus('解析中');
      
      // ===== Whisper①: リアルタイム用（1.5秒固定）開始 =====
      realtimeIntervalRef.current = setInterval(() => {
        sendRealtimeWhisper();
      }, REALTIME_INTERVAL);
      
      log('START', 'Dual Whisper listening started');

    } catch (e) {
      log('START', `Error: ${e}`);
      setError('マイクの使用が許可されていません');
      setState('idle');
    }
  }, [isSupported, currentGain, sendRealtimeWhisper, handleVAD]);

  const stopListening = useCallback(async () => {
    log('STOP', 'Stopping...');
    setState('stopping');

    // タイマークリア
    if (realtimeIntervalRef.current) {
      clearInterval(realtimeIntervalRef.current);
      realtimeIntervalRef.current = null;
    }
    if (vadTimerRef.current) {
      clearTimeout(vadTimerRef.current);
      vadTimerRef.current = null;
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
      
      // 最終音声があれば会話用Whisper②に送信
      if (finalBlob && finalBlob.size > 1000) {
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
    log('STOP', 'Stopped');
  }, []);

  const clearTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
    geminiBufferRef.current = '';
    displayTextRef.current = '';
  }, []);

  useEffect(() => {
    return () => {
      if (realtimeIntervalRef.current) clearInterval(realtimeIntervalRef.current);
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
