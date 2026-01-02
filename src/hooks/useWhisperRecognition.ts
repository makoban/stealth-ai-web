import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioRecorder, transcribeAudio, OPENAI_API_KEY } from '../lib/whisper';

export type RecognitionState = 'idle' | 'starting' | 'listening' | 'processing' | 'stopping';

export interface UseWhisperRecognitionOptions {
  apiKey?: string;
  intervalMs?: number; // 音声を送信する間隔（ミリ秒）
  silenceThreshold?: number; // 無音と判定する閾値（0-1）
}

// Whisperの幻覚（hallucination）としてよく出るフレーズ
// 完全一致でフィルタリングするフレーズ
const HALLUCINATION_EXACT = [
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございます',
  'ご覧いただきありがとうございました',
  'ご覧いただきありがとうございます',
  '本日はご覧いただきありがとうございます',
  '本日はご覧いただきありがとうございました',
  'ありがとうございました',
  'ありがとうございます',
  'お疲れ様でした',
  'よい一日を',
  '良い一日を',
  'おやすみなさい',
  'さようなら',
  'またね',
  'バイバイ',
  '終わり',
  'おしまい',
  'Thank you for watching',
  'Thanks for watching',
  'Subscribe',
  'Like and subscribe',
  'MochiMochi',
  'Amara.org',
  'www.',
  'http',
  '.com',
  '.jp',
  '...',
  '。。。',
  '…',
];

// 部分一致でフィルタリングするフレーズ
const HALLUCINATION_PARTIAL = [
  'チャンネル登録',
  '高評価とチャンネル登録',
  '字幕',
  'subtitles',
  'ご視聴',
  '視聴',
  'ご覧いただき',
  'ご覧頂き',
  'お聴き',
  'お聞き',
  '次回',
  '次の動画',
  'また会いましょう',
  'お楽しみに',
  '提供',
  'スポンサー',
  '広告',
  'CM',
  'コマーシャル',
];

// 幻覚フレーズかどうかをチェック
function isHallucination(text: string): boolean {
  const normalized = text.trim();
  const normalizedLower = normalized.toLowerCase();
  
  // 完全一致チェック
  for (const phrase of HALLUCINATION_EXACT) {
    if (normalized === phrase || normalizedLower === phrase.toLowerCase()) {
      console.log('[Whisper] Hallucination detected (exact):', normalized);
      return true;
    }
  }
  
  // 部分一致チェック
  for (const phrase of HALLUCINATION_PARTIAL) {
    if (normalizedLower.includes(phrase.toLowerCase())) {
      console.log('[Whisper] Hallucination detected (partial):', normalized, 'matched:', phrase);
      return true;
    }
  }
  
  // 短すぎるテキストはノイズの可能性が高い（4文字以下）
  if (normalized.length <= 4) {
    console.log('[Whisper] Hallucination detected (too short):', normalized);
    return true;
  }
  
  // 「！」で終わる短いフレーズは幻覚の可能性が高い
  if (normalized.endsWith('!') && normalized.length < 15) {
    console.log('[Whisper] Hallucination detected (short exclamation):', normalized);
    return true;
  }
  
  // 同じ文字の繰り返し（例: "ああああ", "んんんん"）
  if (/^(.)\1{3,}$/.test(normalized)) {
    console.log('[Whisper] Hallucination detected (repeated char):', normalized);
    return true;
  }
  
  // 音楽記号や特殊文字のみ
  if (/^[♪♫♬♭♮♯♩●○■□▲△★☆※→←↑↓　 ]+$/.test(normalized)) {
    console.log('[Whisper] Hallucination detected (special chars only):', normalized);
    return true;
  }
  
  return false;
}

export function useWhisperRecognition(options: UseWhisperRecognitionOptions = {}) {
  const {
    apiKey = OPENAI_API_KEY,
    intervalMs = 4000, // 4秒ごとに送信
    silenceThreshold = 0.05, // 5%以下は無音と判定
  } = options;

  const [transcript, setTranscript] = useState<string>('');
  const [interimTranscript, setInterimTranscript] = useState<string>('');
  const [state, setState] = useState<RecognitionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState<boolean>(false);
  const [isSpeechDetected, setIsSpeechDetected] = useState<boolean>(false);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [isClipping, setIsClipping] = useState<boolean>(false);
  const [currentGain, setCurrentGain] = useState<number>(50); // 初期値は最大
  const [processingStatus, setProcessingStatus] = useState<string>('');

  const recorderRef = useRef<AudioRecorder | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flushIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isProcessingRef = useRef<boolean>(false);
  const pendingTextRef = useRef<string>('');
  const apiKeyRef = useRef<string>(apiKey);
  const recentAudioLevelsRef = useRef<number[]>([]); // 最近の音声レベルを記録
  const maxAudioLevelRef = useRef<number>(0); // 期間中の最大音声レベル

  // APIキーをrefで保持（再レンダリングを防ぐ）
  useEffect(() => {
    apiKeyRef.current = apiKey;
  }, [apiKey]);

  // サポート確認
  useEffect(() => {
    const supported = typeof navigator.mediaDevices !== 'undefined' && 
      typeof navigator.mediaDevices.getUserMedia === 'function';
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

    // 最大音声レベルをチェック（無音の場合はスキップ）
    const maxLevel = maxAudioLevelRef.current;
    console.log('[Whisper] Max audio level in period:', maxLevel);
    
    if (maxLevel < silenceThreshold) {
      console.log('[Whisper] Silence detected, skipping API call');
      setProcessingStatus(`無音検出（レベル: ${(maxLevel * 100).toFixed(0)}%）`);
      // データをクリアして次の期間へ
      recorderRef.current.getIntermediateBlob();
      maxAudioLevelRef.current = 0;
      recentAudioLevelsRef.current = [];
      return;
    }

    const blob = recorderRef.current.getIntermediateBlob();
    console.log('[Whisper] Got blob:', blob?.size || 0, 'bytes');
    
    // 最大レベルをリセット
    maxAudioLevelRef.current = 0;
    recentAudioLevelsRef.current = [];
    
    // 最小サイズチェック（WAVヘッダー44バイト + 最低限のデータ）
    if (!blob || blob.size < 1000) {
      setProcessingStatus('音声データ不足');
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
        
        // 幻覚フレーズをフィルタリング
        if (isHallucination(newText)) {
          console.log('[Whisper] Filtered hallucination:', newText);
          setProcessingStatus('ノイズ除去（幻覚フィルタ）');
        } else {
          // リアルタイム欄にOpenAI出力をそのまま追加（整形なし）
          pendingTextRef.current = pendingTextRef.current 
            ? pendingTextRef.current + ' ' + newText 
            : newText;
          setInterimTranscript(pendingTextRef.current);
          setProcessingStatus('認識成功: ' + newText.substring(0, 20) + '...');
        }
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
  }, [silenceThreshold]);

  // 一定時間ごとにリアルタイム欄から会話欄に移動
  const flushToTranscript = useCallback(() => {
    if (pendingTextRef.current && pendingTextRef.current.trim()) {
      const textToFlush = pendingTextRef.current.trim();
      console.log('[Whisper] Flushing to transcript:', textToFlush);
      
      // 会話欄に追加（生のOpenAI出力、整形はApp.tsx側で行う）
      setTranscript((prev) => {
        const newTranscript = prev ? prev + '\n' + textToFlush : textToFlush;
        console.log('[Whisper] New transcript:', newTranscript);
        return newTranscript;
      });
      
      // リアルタイム欄をクリア
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
    maxAudioLevelRef.current = 0;
    recentAudioLevelsRef.current = [];
    setProcessingStatus('開始中...');

    try {
      const recorder = new AudioRecorder();
      recorder.setGain(currentGain);
      
      await recorder.start((level, clipping) => {
        setAudioLevel(level);
        setIsClipping(clipping);
        // 最大レベルを更新
        if (level > maxAudioLevelRef.current) {
          maxAudioLevelRef.current = level;
        }
        recentAudioLevelsRef.current.push(level);
        // 最新100件のみ保持
        if (recentAudioLevelsRef.current.length > 100) {
          recentAudioLevelsRef.current.shift();
        }
        // より低い閾値で音声検出
        setIsSpeechDetected(level > 0.02);
      });

      recorderRef.current = recorder;
      setState('listening');
      setProcessingStatus('解析中');

      // 定期的に音声を処理
      intervalRef.current = setInterval(() => {
        processAudio();
      }, intervalMs);

      // 6秒ごとにリアルタイム欄から会話欄に移動
      flushIntervalRef.current = setInterval(() => {
        flushToTranscript();
      }, 6000);

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
      
      // 無音でなく、十分なサイズがある場合のみ処理
      if (finalBlob && finalBlob.size > 1000 && maxAudioLevelRef.current >= silenceThreshold) {
        setState('processing');
        setInterimTranscript('最終処理中...');
        setProcessingStatus('最終処理中...');
        
        try {
          const result = await transcribeAudio(finalBlob, apiKeyRef.current);
          if (result.text && result.text.trim() && !isHallucination(result.text.trim())) {
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
    maxAudioLevelRef.current = 0;
    recentAudioLevelsRef.current = [];
  }, [flushToTranscript, silenceThreshold]);

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
