// AssemblyAI リアルタイム音声認識

// 話者情報付きの認識結果
export interface SpeakerTranscript {
  text: string;
  speaker: string;  // "A", "B", "C" など
  confidence: number;
  timestamp: Date;
}

// AssemblyAI WebSocket接続クラス
export class AssemblyAIRealtime {
  private socket: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private isConnected = false;
  
  // コールバック
  onTranscript: ((text: string, isFinal: boolean, speaker?: string) => void) | null = null;
  onError: ((error: string) => void) | null = null;
  onAudioLevel: ((level: number) => void) | null = null;

  // 一時トークンをバックエンドプロキシ経由で取得
  private async getTemporaryToken(): Promise<string> {
    // プロキシエンドポイントを使用（CORSを回避）
    const response = await fetch('/api/assemblyai/token', {
      method: 'GET',
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Failed to get token: ${response.status} - ${errorData.error || 'Unknown error'}`);
    }

    const data = await response.json();
    return data.token;
  }

  // 接続開始
  async connect(): Promise<void> {
    try {
      // 一時トークンを取得
      const token = await this.getTemporaryToken();
      
      // WebSocket接続
      const wsUrl = `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000&token=${token}`;
      this.socket = new WebSocket(wsUrl);

      this.socket.onopen = () => {
        console.log('[AssemblyAI] WebSocket connected');
        this.isConnected = true;
        
        // 設定を送信
        this.socket?.send(JSON.stringify({
          // 話者分離を有効化
          speaker_labels: true,
          // 日本語
          language_code: 'ja',
        }));
      };

      this.socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.message_type === 'FinalTranscript') {
          // 確定した認識結果
          if (data.text && this.onTranscript) {
            this.onTranscript(data.text, true, data.speaker);
          }
        } else if (data.message_type === 'PartialTranscript') {
          // 途中の認識結果
          if (data.text && this.onTranscript) {
            this.onTranscript(data.text, false, data.speaker);
          }
        } else if (data.error) {
          console.error('[AssemblyAI] Error:', data.error);
          if (this.onError) {
            this.onError(data.error);
          }
        }
      };

      this.socket.onerror = (error) => {
        console.error('[AssemblyAI] WebSocket error:', error);
        if (this.onError) {
          this.onError('WebSocket connection error');
        }
      };

      this.socket.onclose = () => {
        console.log('[AssemblyAI] WebSocket closed');
        this.isConnected = false;
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
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: 16000 });
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
    const processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(this.audioContext.destination);

    processor.onaudioprocess = (event) => {
      if (!this.isConnected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return;
      }

      const inputData = event.inputBuffer.getChannelData(0);
      
      // Float32 to Int16 PCM
      const pcmData = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      // Base64エンコードして送信
      const base64 = this.arrayBufferToBase64(pcmData.buffer);
      this.socket.send(JSON.stringify({ audio_data: base64 }));
    };
  }

  // ArrayBufferをBase64に変換
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // 切断
  disconnect(): void {
    this.isConnected = false;

    if (this.socket) {
      // 終了メッセージを送信
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ terminate_session: true }));
      }
      this.socket.close();
      this.socket = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    console.log('[AssemblyAI] Disconnected');
  }

  // 接続状態を取得
  get connected(): boolean {
    return this.isConnected;
  }
}

// シングルトンインスタンス
export const assemblyAI = new AssemblyAIRealtime();
