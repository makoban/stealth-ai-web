// OpenAI Whisper API for speech recognition (サーバー経由)
import { addWhisperUsage, setOnPointsUpdate } from './gemini';
import { getIdToken } from './firebase';

// Whisper用のポイント更新コールバック
let whisperPointsCallback: ((points: number) => void) | null = null;

export function setWhisperPointsCallback(callback: (points: number) => void): void {
  whisperPointsCallback = callback;
}

// ポイント更新コールバックを両方に設定
export function setPointsUpdateCallback(callback: (points: number) => void): void {
  whisperPointsCallback = callback;
  setOnPointsUpdate(callback);
}

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
  
  // プロンプトは完全に無効化（幻覚防止）
  // Whisperはプロンプトに含まれる単語を誤認識しやすいため、
  // プロンプト機能を無効化して幻覚を防止する
  // if (prompt && prompt.trim()) {
  //   const truncatedPrompt = prompt.trim().slice(0, 400);
  //   formData.append('prompt', truncatedPrompt);
  //   console.log('[Whisper] Using prompt:', truncatedPrompt.slice(0, 100) + '...');
  // }
  console.log('[Whisper] Prompt disabled to prevent hallucination');

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

  // ポイント残高を更新（リアルタイム）
  if (data._points !== undefined && whisperPointsCallback) {
    whisperPointsCallback(data._points);
  }

  return {
    text: data.text || '',
    duration,
    points: data._points, // サーバーから返されるポイント残高
  };
}

// VAD状態の型定義
export type VadState = 'silence' | 'maybe_speech' | 'speech' | 'maybe_silence';

// AudioRecorderのコールバック型定義
export interface AudioLevelInfo {
  level: number;           // 正規化された音量レベル (0-1)
  isClipping: boolean;     // 音割れ検出
  isSpeaking: boolean;     // VADによる発話判定
  vadState: VadState;      // VADの詳細状態
  noiseFloor: number;      // 推定ノイズフロア
  currentGain: number;     // 現在のゲイン値
}

// ScriptProcessorNodeを使った音声録音クラス（WAV出力）
// 高度な音声処理: ノイズ除去、音割れ防止、VAD→AGC構造
export class AudioRecorder {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private preGainAnalyser: AnalyserNode | null = null; // VAD判定用（ゲイン前）
  private scriptProcessor: ScriptProcessorNode | null = null;
  private onAudioLevelCallback: ((info: AudioLevelInfo) => void) | null = null;
  private animationFrameId: number | null = null;
  private audioData: Float32Array[] = [];
  private isRecordingFlag: boolean = false;
  private sampleRate: number = 48000;

  // 高度な音声処理ノード
  private highPassFilter: BiquadFilterNode | null = null;
  private lowPassFilter: BiquadFilterNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;

  // ゲイン設定
  private gainValue: number = 50; // 初期ゲイン（固定PreGain）
  private readonly INITIAL_GAIN = 50;

  // 音割れ検出用
  private clippingCount: number = 0;
  private lastClipTime: number = 0;

  // === VAD（音声区間検出）パラメータ ===
  private noiseFloor: number = 0.05; // 動的ノイズフロア推定値
  private vadState: VadState = 'silence';
  private vadStateStartTime: number = 0;
  
  // ノイズフロア推定パラメータ
  private readonly NOISE_FLOOR_RISE_RATE = 0.002;  // 上昇時は非常にゆっくり（0.01→0.002）
  private readonly NOISE_FLOOR_MIN = 0.001;        // 最小ノイズフロア
  private readonly NOISE_FLOOR_MAX = 0.08;         // 最大ノイズフロア（0.3→0.08）
  
  // ヒステリシスVADパラメータ
  private readonly VAD_ON_MULTIPLIER = 2.5;   // 発話開始閾値 = noiseFloor * 2.5（3.5→2.5）
  private readonly VAD_OFF_MULTIPLIER = 1.5;  // 発話終了閾値 = noiseFloor * 1.5（1.8→1.5）
  private readonly VAD_MAYBE_SPEECH_DURATION = 50;   // maybe_speech → speech (ms)
  private readonly VAD_MAYBE_SILENCE_DURATION = 200; // maybe_silence → silence (ms)

  // === AGC（自動ゲイン調整）パラメータ ===
  private agcEnabled: boolean = true;
  private readonly AGC_TARGET_LEVEL = 0.65;
  private readonly AGC_ATTACK_RATE = 0.3;    // 下げる時は速く
  private readonly AGC_RELEASE_RATE = 0.02;  // 上げる時はゆっくり
  private readonly AGC_MIN_GAIN = 10;
  private readonly AGC_MAX_GAIN = 10000;

  // デバッグログ用
  private lastLogTime: number = 0;
  private readonly LOG_INTERVAL = 1000; // 1秒ごとにログ出力

  async start(onAudioLevel?: (info: AudioLevelInfo) => void): Promise<void> {
    this.onAudioLevelCallback = onAudioLevel || null;
    this.audioData = [];
    this.isRecordingFlag = true;
    this.clippingCount = 0;
    this.noiseFloor = 0.05;
    this.vadState = 'silence';
    this.vadStateStartTime = Date.now();
    this.gainValue = this.INITIAL_GAIN;

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

    // === 音声処理チェーン（VAD → AGC構造） ===

    // 1. ハイパスフィルター（低周波ノイズ除去: エアコン、車の音など）
    this.highPassFilter = this.audioContext.createBiquadFilter();
    this.highPassFilter.type = 'highpass';
    this.highPassFilter.frequency.value = 300;
    this.highPassFilter.Q.value = 0.7;

    // 2. ローパスフィルター（高周波ノイズ除去: キーン音など）
    this.lowPassFilter = this.audioContext.createBiquadFilter();
    this.lowPassFilter.type = 'lowpass';
    this.lowPassFilter.frequency.value = 3400;
    this.lowPassFilter.Q.value = 0.7;

    // 3. VAD判定用アナライザー（ゲイン前の生の音量を測定）
    this.preGainAnalyser = this.audioContext.createAnalyser();
    this.preGainAnalyser.fftSize = 256;
    this.preGainAnalyser.smoothingTimeConstant = 0.5;

    // 4. ゲインノード（AGC用）
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.gainValue;

    // 5. ダイナミクスコンプレッサー（音割れ防止リミッター）
    this.compressor = this.audioContext.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 30;
    this.compressor.ratio.value = 12;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    // 6. 出力用アナライザー（UI表示用）
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

    // 接続チェーン（VAD → AGC構造）:
    // source -> highPass -> lowPass -> preGainAnalyser (VAD判定)
    //                              \-> gain -> compressor -> analyser (UI表示)
    //                                                     -> scriptProcessor -> destination
    source.connect(this.highPassFilter);
    this.highPassFilter.connect(this.lowPassFilter);
    
    // VAD判定用（ゲイン前）
    this.lowPassFilter.connect(this.preGainAnalyser);
    
    // メイン音声経路
    this.lowPassFilter.connect(this.gainNode);
    this.gainNode.connect(this.compressor);
    this.compressor.connect(this.analyser);
    this.compressor.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.audioContext.destination);

    // 音声レベル監視とVAD/AGC処理を開始
    if (this.onAudioLevelCallback) {
      this.startLevelMonitoring();
    }

    console.log('[AudioRecorder] Started with VAD→AGC architecture');
    console.log('[AudioRecorder] Initial settings:', {
      gain: this.gainValue + 'x',
      agcEnabled: this.agcEnabled,
      vadOnThreshold: `noiseFloor * ${this.VAD_ON_MULTIPLIER}`,
      vadOffThreshold: `noiseFloor * ${this.VAD_OFF_MULTIPLIER}`,
    });
  }

  private startLevelMonitoring(): void {
    if (!this.preGainAnalyser || !this.analyser || !this.onAudioLevelCallback) return;

    const preGainDataArray = new Uint8Array(this.preGainAnalyser.frequencyBinCount);
    const postGainDataArray = new Uint8Array(this.analyser.frequencyBinCount);

    const updateLevel = () => {
      if (!this.preGainAnalyser || !this.analyser || !this.onAudioLevelCallback) return;

      // ゲイン前の音量を取得（VAD判定用）
      this.preGainAnalyser.getByteFrequencyData(preGainDataArray);
      const preGainAverage = preGainDataArray.reduce((a, b) => a + b, 0) / preGainDataArray.length;
      const preGainLevel = Math.min(preGainAverage / 128, 1);

      // ゲイン後の音量を取得（UI表示用）
      this.analyser.getByteFrequencyData(postGainDataArray);
      const postGainAverage = postGainDataArray.reduce((a, b) => a + b, 0) / postGainDataArray.length;
      const postGainLevel = Math.min(postGainAverage / 128, 1);

      // ノイズフロア推定（Leaky Min-Hold）
      this.updateNoiseFloor(preGainLevel);

      // ヒステリシスVAD処理
      const isSpeaking = this.processVAD(preGainLevel);

      // AGC処理（発話中のみ）
      if (this.agcEnabled && isSpeaking) {
        this.processAGC(postGainLevel);
      }

      // デバッグログ出力（1秒ごと）
      this.outputDebugLog(preGainLevel, postGainLevel, isSpeaking);

      // 音割れ検出
      const isClipping = (Date.now() - this.lastClipTime) < 1000;

      // コールバック呼び出し
      this.onAudioLevelCallback({
        level: postGainLevel,
        isClipping,
        isSpeaking,
        vadState: this.vadState,
        noiseFloor: this.noiseFloor,
        currentGain: this.gainValue,
      });

      this.animationFrameId = requestAnimationFrame(updateLevel);
    };

    updateLevel();
  }

  // ノイズフロア動的推定（Leaky Min-Hold）
  private updateNoiseFloor(level: number): void {
    if (level < this.noiseFloor) {
      // 下がる時は即座に追従
      this.noiseFloor = level;
    } else {
      // 上がる時はゆっくり追従
      this.noiseFloor += (level - this.noiseFloor) * this.NOISE_FLOOR_RISE_RATE;
    }
    
    // 範囲制限
    this.noiseFloor = Math.max(this.NOISE_FLOOR_MIN, Math.min(this.NOISE_FLOOR_MAX, this.noiseFloor));
  }

  // ヒステリシスVAD処理
  private processVAD(level: number): boolean {
    const thresholdOn = this.noiseFloor * this.VAD_ON_MULTIPLIER;
    const thresholdOff = this.noiseFloor * this.VAD_OFF_MULTIPLIER;
    const now = Date.now();
    const stateDuration = now - this.vadStateStartTime;

    const prevState = this.vadState;

    switch (this.vadState) {
      case 'silence':
        if (level > thresholdOn) {
          this.vadState = 'maybe_speech';
          this.vadStateStartTime = now;
        }
        break;

      case 'maybe_speech':
        if (level <= thresholdOn) {
          // 閾値を下回ったらsilenceに戻る
          this.vadState = 'silence';
          this.vadStateStartTime = now;
        } else if (stateDuration >= this.VAD_MAYBE_SPEECH_DURATION) {
          // 一定時間継続したらspeechに移行
          this.vadState = 'speech';
          this.vadStateStartTime = now;
          console.log('[VAD] Speech started | level:', level.toFixed(4), '| threshold:', thresholdOn.toFixed(4));
        }
        break;

      case 'speech':
        if (level < thresholdOff) {
          this.vadState = 'maybe_silence';
          this.vadStateStartTime = now;
        }
        break;

      case 'maybe_silence':
        if (level >= thresholdOff) {
          // 閾値を超えたらspeechに戻る
          this.vadState = 'speech';
          this.vadStateStartTime = now;
        } else if (stateDuration >= this.VAD_MAYBE_SILENCE_DURATION) {
          // 一定時間継続したらsilenceに移行
          this.vadState = 'silence';
          this.vadStateStartTime = now;
          console.log('[VAD] Speech ended | level:', level.toFixed(4), '| threshold:', thresholdOff.toFixed(4));
        }
        break;
    }

    // 状態変化時にログ出力
    if (prevState !== this.vadState) {
      console.log(`[VAD] State: ${prevState} → ${this.vadState}`);
    }

    return this.vadState === 'speech' || this.vadState === 'maybe_silence';
  }

  // 非対称AGC処理（発話中のみ呼び出される）
  private processAGC(level: number): void {
    if (level < 0.01) return; // 極端に小さい音は無視

    const targetGain = (this.AGC_TARGET_LEVEL / level) * this.gainValue;
    let newGain: number;

    if (targetGain < this.gainValue) {
      // ゲインを下げる（Attack）: 速く
      newGain = this.gainValue + (targetGain - this.gainValue) * this.AGC_ATTACK_RATE;
    } else {
      // ゲインを上げる（Release）: ゆっくり
      newGain = this.gainValue + (targetGain - this.gainValue) * this.AGC_RELEASE_RATE;
    }

    // 範囲制限
    newGain = Math.max(this.AGC_MIN_GAIN, Math.min(this.AGC_MAX_GAIN, Math.round(newGain)));

    // 変化がある場合のみ更新
    if (Math.abs(newGain - this.gainValue) >= 1) {
      const oldGain = this.gainValue;
      this.gainValue = newGain;
      if (this.gainNode) {
        this.gainNode.gain.setTargetAtTime(newGain, this.audioContext!.currentTime, 0.05);
      }
      console.log(`[AGC] Gain: ${oldGain}x → ${newGain}x | level: ${level.toFixed(3)} | target: ${this.AGC_TARGET_LEVEL}`);
    }
  }

  // デバッグログ出力（1秒ごと）
  private outputDebugLog(preGainLevel: number, postGainLevel: number, isSpeaking: boolean): void {
    const now = Date.now();
    if (now - this.lastLogTime < this.LOG_INTERVAL) return;
    this.lastLogTime = now;

    const thresholdOn = this.noiseFloor * this.VAD_ON_MULTIPLIER;
    const thresholdOff = this.noiseFloor * this.VAD_OFF_MULTIPLIER;

    console.log('[MONITOR]', {
      preGain: preGainLevel.toFixed(4),
      postGain: postGainLevel.toFixed(4),
      noiseFloor: this.noiseFloor.toFixed(4),
      thresholdOn: thresholdOn.toFixed(4),
      thresholdOff: thresholdOff.toFixed(4),
      vadState: this.vadState,
      isSpeaking,
      gain: this.gainValue + 'x',
      agcEnabled: this.agcEnabled,
    });
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
    this.preGainAnalyser = null;
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
    this.gainValue = Math.min(Math.max(value, this.AGC_MIN_GAIN), this.AGC_MAX_GAIN);
    if (this.gainNode) {
      this.gainNode.gain.value = this.gainValue;
    }
  }

  getGain(): number {
    return this.gainValue;
  }

  setAgcEnabled(enabled: boolean): void {
    this.agcEnabled = enabled;
    console.log('[AudioRecorder] AGC:', enabled ? 'ON' : 'OFF');
  }

  isAgcEnabled(): boolean {
    return this.agcEnabled;
  }

  isRecording(): boolean {
    return this.isRecordingFlag;
  }

  getClippingCount(): number {
    return this.clippingCount;
  }

  getNoiseFloor(): number {
    return this.noiseFloor;
  }

  getVadState(): VadState {
    return this.vadState;
  }
}
