// AssemblyAI リアルタイム音声認識フック

import { useState, useCallback, useRef, useEffect } from 'react';
import { assemblyAI } from '../lib/assemblyai';

interface UseAssemblyAIOptions {
  onTranscript?: (text: string, isFinal: boolean, speaker?: string) => void;
  onError?: (error: string) => void;
}

export function useAssemblyAI(options: UseAssemblyAIOptions = {}) {
  const [isListening, setIsListening] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [currentText, setCurrentText] = useState('');
  const [error, setError] = useState<string | null>(null);
  
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // 接続開始
  const startListening = useCallback(async () => {
    try {
      setError(null);
      
      // コールバックを設定
      assemblyAI.onTranscript = (text, isFinal, speaker) => {
        if (isFinal) {
          setCurrentText('');
          if (optionsRef.current.onTranscript) {
            optionsRef.current.onTranscript(text, true, speaker);
          }
        } else {
          setCurrentText(text);
          if (optionsRef.current.onTranscript) {
            optionsRef.current.onTranscript(text, false, speaker);
          }
        }
      };

      assemblyAI.onError = (err) => {
        setError(err);
        if (optionsRef.current.onError) {
          optionsRef.current.onError(err);
        }
      };

      assemblyAI.onAudioLevel = (level) => {
        setAudioLevel(level);
      };

      await assemblyAI.connect();
      setIsListening(true);
      
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      if (optionsRef.current.onError) {
        optionsRef.current.onError(errorMessage);
      }
    }
  }, []);

  // 接続停止
  const stopListening = useCallback(() => {
    assemblyAI.disconnect();
    setIsListening(false);
    setCurrentText('');
    setAudioLevel(0);
  }, []);

  // クリーンアップ
  useEffect(() => {
    return () => {
      if (assemblyAI.connected) {
        assemblyAI.disconnect();
      }
    };
  }, []);

  return {
    isListening,
    audioLevel,
    currentText,
    error,
    startListening,
    stopListening,
  };
}
