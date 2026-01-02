// AssemblyAI リアルタイム音声認識 (v3 API)

// 話者情報付きの認識結果
export interface SpeakerTranscript {
  text: string;
  speaker: string;  // "A", "B", "C" など
  confidence: number;
  timestamp: Date;
}

// AssemblyAI WebSocket接続クラス (v3 API対応)
export class AssemblyAIRealtime {
  private socket: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private isConnected = false;
  private processor: ScriptProcessorNode | null = null;
  private audioDataSent = false;
  private actualSampleRate = 48000; // 実際のサンプルレート
  
  // コールバック
  onTranscript: ((text: string, isFinal: boolean, speaker?: string) => void) | null = null;
  onError: ((error: string) => void) | null = null;
  onAudioLevel: ((level: number) => void) | null = null;

  // 一時トークンをバックエンドプロキシ経由で取得
  private async getTemporaryToken(): Promise<string> {
    console.log('[AssemblyAI] Requesting token from proxy...');
    // プロキシエンドポイントを使用（CORSを回避）
    const response = await fetch('/api/assemblyai/token', {
      method: 'GET',
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[AssemblyAI] Token error:', response.status, errorData);
      throw new Error(`Failed to get token: ${response.status} - ${errorData.error || 'Unknown error'}`);
    }

    const data = await response.json();
    console.log('[AssemblyAI] Token received:', data.token ? 'yes' : 'no');
    return data.token;
  }

  // リサンプリング関数 (任意のサンプルレートから16kHzへ)
  private resample(inputData: Float32Array, inputSampleRate: number, outputSampleRate: number): Float32Array {
    const ratio = inputSampleRate / outputSampleRate;
    const outputLength = Math.floor(inputData.length / ratio);
    const output = new Float32Array(outputLength);
    
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, inputData.length - 1);
      const t = srcIndex - srcIndexFloor;
      
      // 線形補間
      output[i] = inputData[srcIndexFloor] * (1 - t) + inputData[srcIndexCeil] * t;
    }
    
    return output;
  }

  // Float32 to Int16 PCM変換
  private float32ToInt16(float32Array: Float32Array): Int16Array {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
  }

  // 接続開始
  async connect(): Promise<void> {
    try {
      // 一時トークンを取得
      const token = await this.getTemporaryToken();
      console.log('[AssemblyAI] Token obtained, connecting to WebSocket...');
      
      // v3 WebSocket接続
      // tokenをクエリパラメータとして渡す
      const params = new URLSearchParams({
        sample_rate: '16000',
        token: token,
        format_turns: 'true',
        speech_model: 'universal-streaming-multilingual', // 日本語対応
        language_detection: 'true', // 言語自動検出
      });
      
      const wsUrl = `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`;
      console.log('[AssemblyAI] Connecting to:', wsUrl.replace(token, 'TOKEN_HIDDEN'));
      
      this.socket = new WebSocket(wsUrl);

      // WebSocket接続待機
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'));
        }, 10000);

        this.socket!.onopen = () => {
          clearTimeout(timeout);
          console.log('[AssemblyAI] WebSocket connected');
          this.isConnected = true;
          resolve();
        };

        this.socket!.onerror = (error) => {
          clearTimeout(timeout);
          console.error('[AssemblyAI] WebSocket error:', error);
          reject(new Error('WebSocket connection error'));
        };
      });

      this.socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[AssemblyAI] Message received:', data.type, data);
          
          if (data.type === 'Begin') {
            // セッション開始確認
            console.log('[AssemblyAI] Session started:', data.id);
          } else if (data.type === 'Turn') {
            // ターンベースの認識結果
            if (data.transcript && this.onTranscript) {
              const isFinal = data.end_of_turn === true;
              console.log('[AssemblyAI] Transcript:', data.transcript, 'Final:', isFinal);
              this.onTranscript(data.transcript, isFinal, data.speaker);
            }
          } else if (data.type === 'Termination') {
            console.log('[AssemblyAI] Session terminated:', data.audio_duration_seconds, 'seconds');
          } else if (data.error) {
            console.error('[AssemblyAI] Error:', data.error);
            if (this.onError) {
              this.onError(data.error);
            }
          }
        } catch (e) {
          console.error('[AssemblyAI] Failed to parse message:', e, event.data);
        }
      };

      this.socket.onclose = (event) => {
        console.log('[AssemblyAI] WebSocket closed:', event.code, event.reason);
        this.isConnected = false;
        
        // 異常終了の場合はエラーを通知
        if (event.code !== 1000 && event.code !== 1005) {
          if (this.onError) {
            this.onError(`Connection closed: ${event.code} ${event.reason}`);
          }
        }
      };

      // マイク入力を開始
      await this.startMicrophone();

    } catch (error) {
      console.error('[AssemblyAI] Connection error:', error);
      if (this.onError) {
        this.onError(String(error));
      }
      throw error;
    }
  }

  // マイク入力を開始
  private async startMicrophone(): Promise<void> {
    console.log('[AssemblyAI] Starting microphone...');
    
    // マイクストリームを取得（サンプルレートは指定しない - デバイスのネイティブレートを使用）
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    console.log('[AssemblyAI] Microphone stream obtained');

    // AudioContextを作成（サンプルレートは指定しない - デバイスのネイティブレートを使用）
    this.audioContext = new AudioContext();
    this.actualSampleRate = this.audioContext.sampleRate;
    console.log('[AssemblyAI] Actual sample rate:', this.actualSampleRate);
    
    const source = this.audioContext.createMediaStreamSource(this.stream);
    
    // 音声レベル監視
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    const checkLevel = () => {
      if (!this.isConnected) return;
      
      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
      const level = Math.min(100, (average / 128) * 100);
      
      if (this.onAudioLevel) {
        this.onAudioLevel(level);
      }
      
      requestAnimationFrame(checkLevel);
    };
    checkLevel();

    // ScriptProcessorで音声データを送信
    // バッファサイズを大きくして安定性を向上
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);

    let audioChunkCount = 0;
    
    this.processor.onaudioprocess = (event) => {
      if (!this.isConnected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return;
      }

      const inputData = event.inputBuffer.getChannelData(0);
      
      // 実際のサンプルレートから16kHzにリサンプリング
      const resampledData = this.resample(inputData, this.actualSampleRate, 16000);
      
      // Float32 to Int16 PCM変換
      const pcmData = this.float32ToInt16(resampledData);

      // バイナリデータとして送信（v3 APIは bytes 形式を期待）
      this.socket.send(pcmData.buffer);
      
      audioChunkCount++;
      if (audioChunkCount % 50 === 0) {
        console.log('[AssemblyAI] Audio chunks sent:', audioChunkCount, 'resampled from', this.actualSampleRate, 'to 16000');
      }
      
      if (!this.audioDataSent) {
        this.audioDataSent = true;
        console.log('[AssemblyAI] First audio data sent, original rate:', this.actualSampleRate, 'resampled to 16000');
      }
    };
    
    console.log('[AssemblyAI] Audio processing started with resampling');
  }

  // 切断
  disconnect(): void {
    console.log('[AssemblyAI] Disconnecting...');
    this.isConnected = false;

    if (this.socket) {
      // v3 API: セッション終了メッセージを送信
      if (this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(JSON.stringify({ type: 'Terminate' }));
        } catch (e) {
          console.error('[AssemblyAI] Error sending terminate:', e);
        }
      }
      this.socket.close();
      this.socket = null;
    }

    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.audioDataSent = false;
    console.log('[AssemblyAI] Disconnected');
  }

  // 接続状態を取得
  get connected(): boolean {
    return this.isConnected;
  }
}

// シングルトンインスタンス
export const assemblyAI = new AssemblyAIRealtime();
