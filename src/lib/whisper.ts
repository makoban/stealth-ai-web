// OpenAI Whisper API for speech recognition
import { addWhisperUsage } from './gemini';

// OpenAI APIキー（環境変数またはローカルストレージから取得）
export const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY || '';

// PCMデータをWAVファイルに変換
function encodeWAV(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  // WAVヘッダーを書き込む
  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size
  view.setUint16(20, 1, true); // AudioFormat (PCM)
  view.setUint16(22, 1, true); // NumChannels (Mono)
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  // PCMデータを書き込む（16bit）
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

// 音声データをWhisper APIに送信して文字起こし
export async function transcribeAudio(
  audioBlob: Blob,
  apiKey: string,
  language: string = 'ja'
): Promise<{ text: string; duration: number }> {
  console.log('[Whisper] Sending audio:', {
    type: audioBlob.type,
    size: audioBlob.size,
  });

  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.wav');
  formData.append('model', 'whisper-1');
  formData.append('language', language);
  formData.append('response_format', 'verbose_json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[Whisper] API error:', response.status, error);
    throw new Error(`Whisper API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const duration = data.duration || 0;
  
  // 使用量を追跡
  addWhisperUsage(duration);

  return {
    text: data.text || '',
    duration,
  };
}

// ScriptProcessorNodeを使った音声録音クラス（WAV出力）
export class AudioRecorder {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private onAudioLevelCallback: ((level: number) => void) | null = null;
  private animationFrameId: number | null = null;
  private audioData: Float32Array[] = [];
  private isRecordingFlag: boolean = false;
  private sampleRate: number = 16000; // Whisperに最適なサンプルレート

  // 音声増幅の倍率
  private gainValue: number = 5.0;

  async start(onAudioLevel?: (level: number) => void): Promise<void> {
    this.onAudioLevelCallback = onAudioLevel || null;
    this.audioData = [];
    this.isRecordingFlag = true;

    // マイクアクセスを取得（ノイズ除去OFF）
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: this.sampleRate,
      },
    });

    // AudioContextを作成
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
      sampleRate: this.sampleRate,
    });
    
    // 実際のサンプルレートを取得
    this.sampleRate = this.audioContext.sampleRate;
    console.log('[AudioRecorder] Sample rate:', this.sampleRate);

    const source = this.audioContext.createMediaStreamSource(this.stream);

    // ゲインノード（増幅）
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.gainValue;

    // アナライザー（音声レベル監視用）
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.3;

    // ScriptProcessorNodeで生のPCMデータを取得
    const bufferSize = 4096;
    this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    
    this.scriptProcessor.onaudioprocess = (e) => {
      if (!this.isRecordingFlag) return;
      
      const inputData = e.inputBuffer.getChannelData(0);
      // データをコピーして保存
      const copy = new Float32Array(inputData.length);
      copy.set(inputData);
      this.audioData.push(copy);
    };

    // 接続: source -> gain -> analyser -> scriptProcessor -> destination
    source.connect(this.gainNode);
    this.gainNode.connect(this.analyser);
    this.gainNode.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.audioContext.destination);

    // 音声レベルを監視
    if (this.onAudioLevelCallback) {
      this.startLevelMonitoring();
    }

    console.log('[AudioRecorder] Started recording');
  }

  private startLevelMonitoring(): void {
    if (!this.analyser || !this.onAudioLevelCallback) return;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    const updateLevel = () => {
      if (!this.analyser || !this.onAudioLevelCallback) return;

      this.analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const normalizedLevel = Math.min(average / 128, 1);
      this.onAudioLevelCallback(normalizedLevel);

      this.animationFrameId = requestAnimationFrame(updateLevel);
    };

    updateLevel();
  }

  stop(): Blob | null {
    this.isRecordingFlag = false;

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.gainNode = null;
    this.analyser = null;
    this.onAudioLevelCallback = null;

    // 録音データをWAVに変換
    if (this.audioData.length > 0) {
      const blob = this.createWavBlob();
      this.audioData = [];
      return blob;
    }
    return null;
  }

  // 現在までの録音データを取得（録音は継続）
  getIntermediateBlob(): Blob | null {
    if (this.audioData.length > 0) {
      const blob = this.createWavBlob();
      this.audioData = []; // データをクリア
      return blob;
    }
    return null;
  }

  private createWavBlob(): Blob {
    // 全てのチャンクを結合
    const totalLength = this.audioData.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.audioData) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    console.log('[AudioRecorder] Creating WAV:', {
      totalSamples: totalLength,
      duration: totalLength / this.sampleRate,
      sampleRate: this.sampleRate,
    });

    return encodeWAV(combined, this.sampleRate);
  }

  setGain(value: number): void {
    this.gainValue = value;
    if (this.gainNode) {
      this.gainNode.gain.value = value;
    }
  }

  isRecording(): boolean {
    return this.isRecordingFlag;
  }
}
