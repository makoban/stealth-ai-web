// AssemblyAI リアルタイム音声認識フック (v3 API対応)

import { useState, useCallback, useRef, useEffect } from 'react';
import { AssemblyAIService, TranscriptionResult } from '../lib/assemblyai';

interface UseAssemblyAIOptions {
  apiKey?: string;
  onTranscript?: (text: string, isFinal: boolean, speaker?: string) => void;
  onError?: (error: string) => void;
}

export function useAssemblyAI(options: UseAssemblyAIOptions = {}) {
  const [isListening, setIsListening] = useState(false);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'>('idle');
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [audioChunksSent, setAudioChunksSent] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  
  const serviceRef = useRef<AssemblyAIService | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // サービスを初期化
  useEffect(() => {
    serviceRef.current = new AssemblyAIService({
      apiKey: options.apiKey || ''
    });

    // コールバックを設定
    serviceRef.current.setOnTranscription((result: TranscriptionResult) => {
      if (result.type === 'Turn' || result.type === 'FinalTranscript') {
        // 確定テキスト
        if (result.transcript && result.transcript.trim()) {
          setTranscript(prev => prev ? prev + '\n' + result.transcript : result.transcript);
          setInterimTranscript('');
          setAudioLevel(50); // 音声検出時はレベルを上げる
          optionsRef.current.onTranscript?.(result.transcript, true, undefined);
        }
      } else if (result.type === 'PartialTranscript') {
        // 暫定テキスト
        setInterimTranscript(result.transcript);
        setAudioLevel(result.transcript ? 30 : 0);
        optionsRef.current.onTranscript?.(result.transcript, false, undefined);
      } else if (result.type === 'Error') {
        setError(result.error || 'Unknown error');
        optionsRef.current.onError?.(result.error || 'Unknown error');
      }
    });

    serviceRef.current.setOnError((err: Error) => {
      setError(err.message);
      optionsRef.current.onError?.(err.message);
    });

    serviceRef.current.setOnStatus((newStatus) => {
      setStatus(newStatus === 'connecting' ? 'connecting' : 
                newStatus === 'connected' ? 'connected' : 
                newStatus === 'disconnected' ? 'disconnected' : 'error');
      if (newStatus === 'connected') {
        setIsListening(true);
      } else if (newStatus === 'disconnected' || newStatus === 'error') {
        setIsListening(false);
      }
    });

    return () => {
      if (serviceRef.current?.getIsRecording()) {
        serviceRef.current.stop();
      }
    };
  }, [options.apiKey]);

  // 接続開始
  const startListening = useCallback(async () => {
    if (!serviceRef.current) return;
    
    try {
      setError(null);
      setStatus('connecting');
      await serviceRef.current.start();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setStatus('error');
      optionsRef.current.onError?.(errorMessage);
    }
  }, []);

  // 接続停止
  const stopListening = useCallback(async () => {
    if (!serviceRef.current) return;
    
    try {
      setAudioChunksSent(serviceRef.current.getAudioChunksSent());
      await serviceRef.current.stop();
      setIsListening(false);
      setInterimTranscript('');
      setStatus('disconnected');
    } catch (err) {
      console.error('[useAssemblyAI] Stop error:', err);
    }
  }, []);

  // テキストをクリア
  const clearTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
    serviceRef.current?.clearTranscript();
  }, []);

  // ブラウザサポートチェック
  const isSupported = typeof window !== 'undefined' && 
    'AudioContext' in window && 
    'mediaDevices' in navigator &&
    'getUserMedia' in navigator.mediaDevices;

  return {
    isListening,
    isRecording: isListening,
    status,
    transcript,
    interimTranscript,
    error,
    audioChunksSent,
    audioLevel,
    isSupported,
    startListening,
    startRecording: startListening,
    stopListening,
    stopRecording: stopListening,
    clearTranscript,
  };
}
