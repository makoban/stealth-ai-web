// OpenAI Whisper API for speech recognition
import { addWhisperUsage } from './gemini';

// OpenAI APIキー（環境変数またはローカルストレージから取得）
export const OPENAI_API_KEY = '';

// 音声データをWhisper APIに送信して文字起こし
export async function transcribeAudio(
  audioBlob: Blob,
  apiKey: string,
  language: string = 'ja'
): Promise<{ text: string; duration: number }> {
  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.webm');
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

// MediaRecorderで音声を録音するクラス
export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private onAudioLevelCallback: ((level: number) => void) | null = null;
  private animationFrameId: number | null = null;

  // 音声増幅の倍率
  private gainValue: number = 3.0;

  async start(onAudioLevel?: (level: number) => void): Promise<void> {
    this.onAudioLevelCallback = onAudioLevel || null;
    this.audioChunks = [];

    // マイクアクセスを取得（ノイズ除去OFF）
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    // AudioContextで音声を増幅
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.stream);

    // ゲインノード（増幅）
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.gainValue;

    // アナライザー（音声レベル監視用）
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.3;

    // 増幅した音声を出力先に接続
    const destination = this.audioContext.createMediaStreamDestination();
    source.connect(this.gainNode);
    this.gainNode.connect(this.analyser);
    this.gainNode.connect(destination);

    // 増幅された音声ストリームでMediaRecorderを作成
    this.mediaRecorder = new MediaRecorder(destination.stream, {
      mimeType: this.getSupportedMimeType(),
    });

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.audioChunks.push(event.data);
      }
    };

    this.mediaRecorder.start(1000); // 1秒ごとにデータを取得

    // 音声レベルを監視
    if (this.onAudioLevelCallback) {
      this.startLevelMonitoring();
    }
  }

  private getSupportedMimeType(): string {
    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    for (const mimeType of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        return mimeType;
      }
    }
    return 'audio/webm';
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
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
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

    if (this.audioChunks.length > 0) {
      return new Blob(this.audioChunks, { type: this.getSupportedMimeType() });
    }
    return null;
  }

  // 現在までの録音データを取得（録音は継続）
  getIntermediateBlob(): Blob | null {
    if (this.audioChunks.length > 0) {
      const blob = new Blob(this.audioChunks, { type: this.getSupportedMimeType() });
      this.audioChunks = []; // チャンクをクリア
      return blob;
    }
    return null;
  }

  setGain(value: number): void {
    this.gainValue = value;
    if (this.gainNode) {
      this.gainNode.gain.value = value;
    }
  }

  isRecording(): boolean {
    return this.mediaRecorder?.state === 'recording';
  }
}
