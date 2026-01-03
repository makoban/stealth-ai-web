// OpenAI Whisper API for speech recognition (サーバー経由)
import { addWhisperUsage } from './gemini';
import { getIdToken } from './firebase';

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

// ポイント不足エラー
export class InsufficientPointsError extends Error {
  remaining: number;
  required: number;
  
  constructor(remaining: number, required: number) {
    super('ポイントが不足しています');
    this.name = 'InsufficientPointsError';
    this.remaining = remaining;
    this.required = required;
  }
}

// 音声データをサーバー経由でWhisper APIに送信して文字起こし
export async function transcribeAudio(
  audioBlob: Blob,
  prompt?: string // 固有名詞や専門用語のヒント（最大224トークン）
): Promise<{ text: string; duration: number; points?: number }> {
  console.log('[Whisper] Sending audio via server proxy:', {
    type: audioBlob.type,
    size: audioBlob.size,
    hasPrompt: !!prompt,
    promptLength: prompt?.length || 0,
  });

  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.wav');
  
  // プロンプトがあれば追加（固有名詞の認識精度向上）
  if (prompt && prompt.trim()) {
    // Whisperのプロンプトは最大224トークンなので、約400文字に制限
    const truncatedPrompt = prompt.trim().slice(0, 400);
    formData.append('prompt', truncatedPrompt);
    console.log('[Whisper] Using prompt:', truncatedPrompt.slice(0, 100) + '...');
  }

  // 認証トークンを取得
  const headers: HeadersInit = {};
  const token = await getIdToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // サーバー経由でAPIを呼び出し（APIキーはサーバー側で管理）
  const response = await fetch('/api/whisper', {
    method: 'POST',
    headers,
    body: formData,
  });

  // ポイント不足エラー
  if (response.status === 402) {
    const error = await response.json();
    throw new InsufficientPointsError(error.remaining, error.required);
  }

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
    points: data._points, // サーバーから返されるポイント残高
  };
}

// ScriptProcessorNodeを使った音声録音クラス（WAV出力）
// 高度な音声処理: ノイズ除去、音割れ防止、スマートAGC
export class AudioRecorder {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private onAudioLevelCallback: ((level: number, isClipping: boolean) => void) | null = null;
  private animationFrameId: number | null = null;
  private audioData: Float32Array[] = [];
  private isRecordingFlag: boolean = false;
  private sampleRate: number = 48000;

  // 高度な音声処理ノード
  private highPassFilter: BiquadFilterNode | null = null;
  private lowPassFilter: BiquadFilterNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;

  // 音声増幅の倍率（最大50x）
  private gainValue: number = 50;

  // 音割れ検出用
  private clippingCount: number = 0;
  private lastClipTime: number = 0;

  async start(onAudioLevel?: (level: number, isClipping: boolean) => void): Promise<void> {
    this.onAudioLevelCallback = onAudioLevel || null;
    this.audioData = [];
    this.isRecordingFlag = true;
    this.clippingCount = 0;

    // マイクアクセスを取得（ブラウザのノイズ処理はOFF、独自処理を使用）
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    // AudioContextを作成
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.sampleRate = this.audioContext.sampleRate;
    console.log('[AudioRecorder] Sample rate:', this.sampleRate);

    const source = this.audioContext.createMediaStreamSource(this.stream);

    // === 高度な音声処理チェーン ===

    // 1. ハイパスフィルター（低周波ノイズ除去: エアコン、車の音など）
    // 人の声は約85Hz以上なので、80Hz以下をカット
    this.highPassFilter = this.audioContext.createBiquadFilter();
    this.highPassFilter.type = 'highpass';
    this.highPassFilter.frequency.value = 80;
    this.highPassFilter.Q.value = 0.7;

    // 2. ローパスフィルター（高周波ノイズ除去: キーン音など）
    // 人の声は約3400Hz以下なので、4000Hz以上をカット
    this.lowPassFilter = this.audioContext.createBiquadFilter();
    this.lowPassFilter.type = 'lowpass';
    this.lowPassFilter.frequency.value = 4000;
    this.lowPassFilter.Q.value = 0.7;

    // 3. ゲインノード（増幅）
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.gainValue;

    // 4. ダイナミクスコンプレッサー（音割れ防止）
    this.compressor = this.audioContext.createDynamicsCompressor();
    this.compressor.threshold.value = -24;  // 圧縮開始レベル（dB）
    this.compressor.knee.value = 30;        // 圧縮の滑らかさ
    this.compressor.ratio.value = 12;       // 圧縮比率
    this.compressor.attack.value = 0.003;   // 反応速度（秒）
    this.compressor.release.value = 0.25;   // 解放速度（秒）

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
      
      // 音割れ検出
      for (let i = 0; i < inputData.length; i++) {
        if (Math.abs(inputData[i]) > 0.99) {
          this.clippingCount++;
          this.lastClipTime = Date.now();
          break;
        }
      }

      // データをコピーして保存
      const copy = new Float32Array(inputData.length);
      copy.set(inputData);
      this.audioData.push(copy);
    };

    // 接続チェーン:
    // source -> highPass -> lowPass -> gain -> compressor -> analyser
    //                                                     -> scriptProcessor -> destination
    source.connect(this.highPassFilter);
    this.highPassFilter.connect(this.lowPassFilter);
    this.lowPassFilter.connect(this.gainNode);
    this.gainNode.connect(this.compressor);
    this.compressor.connect(this.analyser);
    this.compressor.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.audioContext.destination);

    // 音声レベルを監視
    if (this.onAudioLevelCallback) {
      this.startLevelMonitoring();
    }

    console.log('[AudioRecorder] Started with advanced audio processing (HP: 80Hz, LP: 4000Hz, Compressor, Gain:', this.gainValue + 'x)');
  }

  private startLevelMonitoring(): void {
    if (!this.analyser || !this.onAudioLevelCallback) return;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    const updateLevel = () => {
      if (!this.analyser || !this.onAudioLevelCallback) return;

      this.analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const normalizedLevel = Math.min(average / 128, 1);
      
      // 最近1秒以内に音割れがあったかどうか
      const isClipping = (Date.now() - this.lastClipTime) < 1000;
      
      this.onAudioLevelCallback(normalizedLevel, isClipping);

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
    this.highPassFilter = null;
    this.lowPassFilter = null;
    this.compressor = null;
    this.onAudioLevelCallback = null;

    // 録音データをWAVに変換
    if (this.audioData.length > 0) {
      const blob = this.createWavBlob();
      console.log('[AudioRecorder] Stopped. Clipping events:', this.clippingCount);
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

    const durationSec = totalLength / this.sampleRate;
    console.log('[AudioRecorder] Creating WAV:', {
      totalSamples: totalLength,
      duration: durationSec.toFixed(2) + 's',
      sampleRate: this.sampleRate,
      estimatedSize: (44 + totalLength * 2) + ' bytes',
    });

    return encodeWAV(combined, this.sampleRate);
  }

  setGain(value: number): void {
    // 最大50xまで許可
    this.gainValue = Math.min(Math.max(value, 1), 50);
    if (this.gainNode) {
      this.gainNode.gain.value = this.gainValue;
    }
  }

  getGain(): number {
    return this.gainValue;
  }

  isRecording(): boolean {
    return this.isRecordingFlag;
  }

  getClippingCount(): number {
    return this.clippingCount;
  }
}
