import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioRecorder, transcribeAudio, OPENAI_API_KEY } from '../lib/whisper';

export type RecognitionState = 'idle' | 'starting' | 'listening' | 'processing' | 'stopping';

export interface UseWhisperRecognitionOptions {
  apiKey?: string;
  intervalMs?: number; // 音声を送信する間隔（ミリ秒）
  gainValue?: number; // 音声増幅倍率
}

export function useWhisperRecognition(options: UseWhisperRecognitionOptions = {}) {
  const {
    apiKey = OPENAI_API_KEY,
    intervalMs = 3000, // 3秒ごとに送信
    gainValue = 3.0,
  } = options;

  const [transcript, setTranscript] = useState<string>('');
  const [interimTranscript, setInterimTranscript] = useState<string>('');
  const [state, setState] = useState<RecognitionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState<boolean>(false);
  const [isSpeechDetected, setIsSpeechDetected] = useState<boolean>(false);
  const [audioLevel, setAudioLevel] = useState<number>(0);

  const recorderRef = useRef<AudioRecorder | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isProcessingRef = useRef<boolean>(false);

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

  // 定期的に音声を送信して文字起こし
  const processAudio = useCallback(async () => {
    if (!recorderRef.current || isProcessingRef.current) return;

    const blob = recorderRef.current.getIntermediateBlob();
    if (!blob || blob.size < 1000) return; // 小さすぎるデータはスキップ

    isProcessingRef.current = true;
    setInterimTranscript('認識中...');

    try {
      const result = await transcribeAudio(blob, apiKey);
      
      if (result.text && result.text.trim()) {
        const newText = result.text.trim();
        setTranscript((prev) => prev ? prev + '\n' + newText : newText);
        setInterimTranscript('');
      } else {
        setInterimTranscript('');
      }
    } catch (e) {
      console.error('[Whisper] Transcription error:', e);
      // APIキーエラーの場合
      if (e instanceof Error && e.message.includes('401')) {
        setError('OpenAI APIキーが無効です。設定を確認してください。');
      }
    } finally {
      isProcessingRef.current = false;
    }
  }, [apiKey]);

  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('音声録音はサポートされていません');
      return;
    }

    // APIキーチェック
    if (!apiKey || apiKey.includes('XXXX')) {
      setError('OpenAI APIキーを設定してください');
      return;
    }

    setError(null);
    setState('starting');

    try {
      const recorder = new AudioRecorder();
      recorder.setGain(gainValue);
      
      await recorder.start((level) => {
        setAudioLevel(level);
        setIsSpeechDetected(level > 0.05);
      });

      recorderRef.current = recorder;
      setState('listening');

      // 定期的に音声を処理
      intervalRef.current = setInterval(() => {
        processAudio();
      }, intervalMs);

    } catch (e) {
      console.error('[Whisper] Failed to start:', e);
      setError('マイクの使用が許可されていません');
      setState('idle');
    }
  }, [isSupported, apiKey, gainValue, intervalMs, processAudio]);

  const stopListening = useCallback(async () => {
    setState('stopping');

    // インターバルを停止
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    // 最後の音声を処理
    if (recorderRef.current) {
      const finalBlob = recorderRef.current.stop();
      
      if (finalBlob && finalBlob.size > 1000) {
        setState('processing');
        setInterimTranscript('最終処理中...');
        
        try {
          const result = await transcribeAudio(finalBlob, apiKey);
          if (result.text && result.text.trim()) {
            setTranscript((prev) => prev ? prev + '\n' + result.text.trim() : result.text.trim());
          }
        } catch (e) {
          console.error('[Whisper] Final transcription error:', e);
        }
      }
      
      recorderRef.current = null;
    }

    setState('idle');
    setInterimTranscript('');
    setIsSpeechDetected(false);
    setAudioLevel(0);
  }, [apiKey]);

  const clearTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
  }, []);

  // クリーンアップ
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
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
    startListening,
    stopListening,
    clearTranscript,
  };
}
