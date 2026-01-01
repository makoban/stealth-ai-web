import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioRecorder, transcribeAudio, OPENAI_API_KEY } from '../lib/whisper';

export type RecognitionState = 'idle' | 'starting' | 'listening' | 'processing' | 'stopping';

export interface UseWhisperRecognitionOptions {
  apiKey?: string;
  intervalMs?: number; // 音声を送信する間隔（ミリ秒）
}

export function useWhisperRecognition(options: UseWhisperRecognitionOptions = {}) {
  const {
    apiKey = OPENAI_API_KEY,
    intervalMs = 3000, // 3秒ごとに送信（短すぎると認識精度が下がる）
  } = options;

  const [transcript, setTranscript] = useState<string>('');
  const [interimTranscript, setInterimTranscript] = useState<string>('');
  const [state, setState] = useState<RecognitionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState<boolean>(false);
  const [isSpeechDetected, setIsSpeechDetected] = useState<boolean>(false);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [currentGain, setCurrentGain] = useState<number>(5.0);
  const [processingStatus, setProcessingStatus] = useState<string>('');

  const recorderRef = useRef<AudioRecorder | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flushIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isProcessingRef = useRef<boolean>(false);
  const pendingTextRef = useRef<string>('');
  const apiKeyRef = useRef<string>(apiKey);

  // APIキーをrefで保持（再レンダリングを防ぐ）
  useEffect(() => {
    apiKeyRef.current = apiKey;
  }, [apiKey]);

  // サポート確認
  useEffect(() => {
    const supported = typeof navigator.mediaDevices !== 'undefined' && 
      typeof navigator.mediaDevices.getUserMedia === 'function' && 
      typeof window.MediaRecorder !== 'undefined';
    setIsSupported(supported);
    if (!supported) {
      setError('このブラウザは音声録音をサポートしていません。');
    }
  }, []);

  // ゲイン値の変更（録音中でもリアルタイムに反映）
  const setGain = useCallback((value: number) => {
    setCurrentGain(value);
    if (recorderRef.current) {
      recorderRef.current.setGain(value);
    }
  }, []);

  // 定期的に音声を送信して文字起こし
  const processAudio = useCallback(async () => {
    if (!recorderRef.current) {
      console.log('[Whisper] No recorder');
      return;
    }
    if (isProcessingRef.current) {
      console.log('[Whisper] Already processing');
      return;
    }
    if (!recorderRef.current.isRecording()) {
      console.log('[Whisper] Not recording');
      return;
    }

    const blob = recorderRef.current.getIntermediateBlob();
    console.log('[Whisper] Got blob:', blob?.size || 0, 'bytes');
    
    // 最小サイズを100バイトに下げる
    if (!blob || blob.size < 100) {
      setProcessingStatus('音声データ収集中...');
      return;
    }

    isProcessingRef.current = true;
    setProcessingStatus('Whisper APIに送信中...');
    
    // 処理中は「...」を表示
    const currentPending = pendingTextRef.current;
    setInterimTranscript(currentPending ? currentPending + ' 🎤...' : '🎤 認識中...');

    try {
      console.log('[Whisper] Sending to API...');
      const result = await transcribeAudio(blob, apiKeyRef.current);
      console.log('[Whisper] Result:', result);
      
      if (result.text && result.text.trim()) {
        const newText = result.text.trim();
        // リアルタイム欄に追加
        pendingTextRef.current = pendingTextRef.current 
          ? pendingTextRef.current + ' ' + newText 
          : newText;
        setInterimTranscript(pendingTextRef.current);
        setProcessingStatus('認識成功');
      } else {
        setProcessingStatus('音声なし（無音）');
      }
    } catch (e) {
      console.error('[Whisper] Transcription error:', e);
      setProcessingStatus('エラー: ' + (e instanceof Error ? e.message : '不明'));
      if (e instanceof Error && e.message.includes('401')) {
        setError('OpenAI APIキーが無効です。設定を確認してください。');
      } else if (e instanceof Error && e.message.includes('429')) {
        setError('API制限に達しました。しばらく待ってください。');
      }
    } finally {
      isProcessingRef.current = false;
    }
  }, []);

  // 一定時間ごとにリアルタイム欄から会話欄に移動
  const flushToTranscript = useCallback(() => {
    if (pendingTextRef.current) {
      console.log('[Whisper] Flushing to transcript:', pendingTextRef.current);
      setTranscript((prev) => prev ? prev + '\n' + pendingTextRef.current : pendingTextRef.current);
      pendingTextRef.current = '';
      setInterimTranscript('');
    }
  }, []);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('音声録音はサポートされていません');
      return;
    }

    // APIキーチェック
    const key = apiKeyRef.current;
    if (!key || key.includes('XXXX') || key.length < 10) {
      setError('OpenAI APIキーを設定してください');
      return;
    }

    setError(null);
    setState('starting');
    pendingTextRef.current = '';
    setProcessingStatus('開始中...');

    try {
      const recorder = new AudioRecorder();
      recorder.setGain(currentGain);
      
      await recorder.start((level) => {
        setAudioLevel(level);
        // より低い閾値で音声検出
        setIsSpeechDetected(level > 0.02);
      });

      recorderRef.current = recorder;
      setState('listening');
      setProcessingStatus('録音中');

      // 定期的に音声を処理（1.5秒ごと）
      intervalRef.current = setInterval(() => {
        processAudio();
      }, intervalMs);

      // 8秒ごとにリアルタイム欄から会話欄に移動
      flushIntervalRef.current = setInterval(() => {
        flushToTranscript();
      }, 8000);

    } catch (e) {
      console.error('[Whisper] Failed to start:', e);
      setError('マイクの使用が許可されていません');
      setState('idle');
      setProcessingStatus('');
    }
  }, [isSupported, currentGain, intervalMs, processAudio, flushToTranscript]);

  const stopListening = useCallback(async () => {
    setState('stopping');
    setProcessingStatus('停止中...');

    // インターバルを停止
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (flushIntervalRef.current) {
      clearInterval(flushIntervalRef.current);
      flushIntervalRef.current = null;
    }

    // 最後の音声を処理
    if (recorderRef.current) {
      const finalBlob = recorderRef.current.stop();
      
      if (finalBlob && finalBlob.size > 100) {
        setState('processing');
        setInterimTranscript('最終処理中...');
        setProcessingStatus('最終処理中...');
        
        try {
          const result = await transcribeAudio(finalBlob, apiKeyRef.current);
          if (result.text && result.text.trim()) {
            pendingTextRef.current = pendingTextRef.current 
              ? pendingTextRef.current + ' ' + result.text.trim() 
              : result.text.trim();
          }
        } catch (e) {
          console.error('[Whisper] Final transcription error:', e);
        }
      }
      
      recorderRef.current = null;
    }

    // 残りのテキストを会話欄に移動
    flushToTranscript();

    setState('idle');
    setInterimTranscript('');
    setIsSpeechDetected(false);
    setAudioLevel(0);
    setProcessingStatus('');
  }, [flushToTranscript]);

  const clearTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
    pendingTextRef.current = '';
  }, []);

  // クリーンアップ
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      if (flushIntervalRef.current) {
        clearInterval(flushIntervalRef.current);
      }
      if (recorderRef.current) {
        recorderRef.current.stop();
      }
    };
  }, []);

  return {
    transcript,
    interimTranscript,
    state,
    isListening: state === 'listening' || state === 'processing',
    isSpeechDetected,
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
