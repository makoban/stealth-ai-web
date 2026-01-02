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
      console.log('[AssemblyAI] Token obtained, connecting to WebSocket...');
      
      // v3 WebSocket接続
      // speech_model=universal-streaming-multilingual で日本語対応
      const wsUrl = `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&token=${token}&speech_model=universal-streaming-multilingual`;
      this.socket = new WebSocket(wsUrl);

      this.socket.onopen = () => {
        console.log('[AssemblyAI] WebSocket connected');
        this.isConnected = true;
      };

      this.socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[AssemblyAI] Message received:', data.type);
          
          if (data.type === 'Begin') {
            // セッション開始確認
            console.log('[AssemblyAI] Session started:', data.id);
          } else if (data.type === 'Turn') {
            // ターンベースの認識結果
            if (data.transcript && this.onTranscript) {
              const isFinal = data.turn_is_formatted === true || data.end_of_turn === true;
              this.onTranscript(data.transcript, isFinal, data.speaker);
            }
          } else if (data.type === 'Termination') {
            console.log('[AssemblyAI] Session terminated:', data.reason);
          } else if (data.error) {
            console.error('[AssemblyAI] Error:', data.error);
            if (this.onError) {
              this.onError(data.error);
            }
          }
        } catch (e) {
          console.error('[AssemblyAI] Failed to parse message:', e);
        }
      };

      this.socket.onerror = (error) => {
        console.error('[AssemblyAI] WebSocket error:', error);
        if (this.onError) {
          this.onError('WebSocket connection error');
        }
      };

      this.socket.onclose = (event) => {
        console.log('[AssemblyAI] WebSocket closed:', event.code, event.reason);
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
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);

    this.processor.onaudioprocess = (event) => {
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

      // v3 APIではバイナリデータを直接送信
      this.socket.send(pcmData.buffer);
    };
  }

  // 切断
  disconnect(): void {
    this.isConnected = false;

    if (this.socket) {
      // v3 API: セッション終了メッセージを送信
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'Terminate' }));
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

    console.log('[AssemblyAI] Disconnected');
  }

  // 接続状態を取得
  get connected(): boolean {
    return this.isConnected;
  }
}

// シングルトンインスタンス
export const assemblyAI = new AssemblyAIRealtime();
