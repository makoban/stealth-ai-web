/**
 * AssemblyAI Real-time Transcription Service
 * Using v3 WebSocket API with AudioWorklet
 * 
 * 公式実装参考: https://github.com/AssemblyAI/realtime-transcription-browser-js-example
 */

export interface AssemblyAIConfig {
  apiKey: string;
  sampleRate?: number;
  language?: string;
}

export interface TranscriptionResult {
  type: 'Turn' | 'PartialTranscript' | 'FinalTranscript' | 'SessionBegins' | 'Error';
  turn_order?: number;
  transcript: string;
  confidence?: number;
  session_id?: string;
  error?: string;
}

export type TranscriptionCallback = (result: TranscriptionResult) => void;
export type ErrorCallback = (error: Error) => void;
export type StatusCallback = (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void;

export class AssemblyAIService {
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private audioWorkletNode: AudioWorkletNode | null = null;
  private mediaStream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  
  private config: AssemblyAIConfig;
  private onTranscription: TranscriptionCallback | null = null;
  private onError: ErrorCallback | null = null;
  private onStatus: StatusCallback | null = null;
  
  private isRecording = false;
  private turns: Map<number, string> = new Map();
  private audioChunksSent = 0;
  
  // Audio buffer for accumulating 100ms of audio before sending
  private audioBufferQueue: Int16Array = new Int16Array(0);
  private readonly MIN_BUFFER_DURATION_MS = 100; // Send every 100ms

  constructor(config: AssemblyAIConfig) {
    this.config = {
      sampleRate: 16000,
      language: 'ja',
      ...config
    };
    console.log('[AssemblyAI] Service created with config:', {
      sampleRate: this.config.sampleRate,
      language: this.config.language,
      hasApiKey: !!this.config.apiKey
    });
  }

  /**
   * Set callback for transcription results
   */
  setOnTranscription(callback: TranscriptionCallback): void {
    this.onTranscription = callback;
  }

  /**
   * Set callback for errors
   */
  setOnError(callback: ErrorCallback): void {
    this.onError = callback;
  }

  /**
   * Set callback for status changes
   */
  setOnStatus(callback: StatusCallback): void {
    this.onStatus = callback;
  }

  /**
   * Merge two Int16Array buffers
   */
  private mergeBuffers(lhs: Int16Array, rhs: Int16Array): Int16Array {
    const mergedBuffer = new Int16Array(lhs.length + rhs.length);
    mergedBuffer.set(lhs, 0);
    mergedBuffer.set(rhs, lhs.length);
    return mergedBuffer;
  }

  /**
   * Get temporary token from AssemblyAI API
   * Can use direct API call or server proxy
   */
  private async getTemporaryToken(): Promise<string> {
    console.log('[AssemblyAI] Getting temporary token...');
    
    // Try server proxy first (to hide API key from client)
    try {
      const proxyResponse = await fetch('/api/assemblyai/token', {
        method: 'GET',
      });
      
      if (proxyResponse.ok) {
        const proxyData = await proxyResponse.json();
        if (proxyData.token) {
          console.log('[AssemblyAI] Token obtained via server proxy');
          return proxyData.token;
        }
      }
    } catch (e) {
      console.warn('[AssemblyAI] Server proxy failed, trying direct API:', e);
    }
    
    // Fallback to direct API call if server proxy fails
    if (!this.config.apiKey) {
      throw new Error('AssemblyAI API key is required');
    }
    
    const response = await fetch('https://api.assemblyai.com/v2/realtime/token', {
      method: 'POST',
      headers: {
        'Authorization': this.config.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        expires_in: 3600 // Token valid for 1 hour
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[AssemblyAI] Token request failed:', response.status, errorText);
      throw new Error(`Failed to get AssemblyAI token: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('[AssemblyAI] Token obtained successfully');
    return data.token;
  }

  /**
   * Initialize microphone with AudioWorklet (16kHz)
   */
  private async initializeMicrophone(): Promise<void> {
    console.log('[AssemblyAI] Initializing microphone...');
    
    // Request microphone permission
    this.mediaStream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      } 
    });
    console.log('[AssemblyAI] Microphone permission granted');

    // Create AudioContext with 16kHz sample rate
    // Using 'balanced' latencyHint as per official implementation
    try {
      this.audioContext = new AudioContext({
        sampleRate: this.config.sampleRate!,
        latencyHint: 'balanced'
      });
      console.log('[AssemblyAI] AudioContext created with sample rate:', this.audioContext.sampleRate);
    } catch (e) {
      console.warn('[AssemblyAI] Could not create AudioContext with 16kHz, using default');
      this.audioContext = new AudioContext({
        latencyHint: 'balanced'
      });
      console.log('[AssemblyAI] AudioContext created with default sample rate:', this.audioContext.sampleRate);
    }

    // Load AudioWorklet processor
    try {
      await this.audioContext.audioWorklet.addModule('/audio-processor.js');
      console.log('[AssemblyAI] AudioWorklet module loaded');
    } catch (error) {
      console.error('[AssemblyAI] Failed to load AudioWorklet module:', error);
      throw new Error('AudioWorklet not supported in this browser');
    }

    // Create source from media stream
    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);

    // Create AudioWorklet node
    this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'audio-processor');
    console.log('[AssemblyAI] AudioWorklet node created');

    // Connect nodes
    this.source.connect(this.audioWorkletNode);
    // Connect to destination (required for some browsers to process audio)
    this.audioWorkletNode.connect(this.audioContext.destination);

    // Reset audio buffer
    this.audioBufferQueue = new Int16Array(0);

    // Handle audio data from worklet
    this.audioWorkletNode.port.onmessage = (event) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && event.data.audio_data) {
        // Get Int16Array from worklet
        const currentBuffer = new Int16Array(event.data.audio_data);
        
        // Merge with existing buffer
        this.audioBufferQueue = this.mergeBuffers(this.audioBufferQueue, currentBuffer);
        
        // Calculate buffer duration in milliseconds
        const bufferDuration = (this.audioBufferQueue.length / this.audioContext!.sampleRate) * 1000;
        
        // Wait until we have MIN_BUFFER_DURATION_MS of audio data
        if (bufferDuration >= this.MIN_BUFFER_DURATION_MS) {
          const totalSamples = Math.floor(this.audioContext!.sampleRate * (this.MIN_BUFFER_DURATION_MS / 1000));
          
          // Create Uint8Array from Int16Array buffer (this is the key fix!)
          const finalBuffer = new Uint8Array(
            this.audioBufferQueue.subarray(0, totalSamples).buffer
          );
          
          // Remove sent samples from queue
          this.audioBufferQueue = this.audioBufferQueue.subarray(totalSamples);
          
          // Send audio data as Uint8Array (binary)
          this.ws.send(finalBuffer);
          this.audioChunksSent++;
          
          // Log every 50 chunks
          if (this.audioChunksSent % 50 === 0) {
            console.log(`[AssemblyAI] Audio chunks sent: ${this.audioChunksSent}`);
          }
        }
      }
    };

    console.log('[AssemblyAI] Microphone initialized successfully');
  }

  /**
   * Start real-time transcription
   */
  async start(): Promise<void> {
    if (this.isRecording) {
      console.warn('[AssemblyAI] Already recording');
      return;
    }

    try {
      this.onStatus?.('connecting');
      this.audioChunksSent = 0;
      this.audioBufferQueue = new Int16Array(0);
      
      // Get temporary token
      const token = await this.getTemporaryToken();

      // Initialize microphone
      await this.initializeMicrophone();

      // Connect to WebSocket (v3 API)
      // Using format_turns=true for formatted transcripts
      // Using speech_model=universal-streaming-multilingual for Japanese support
      const endpoint = `wss://streaming.assemblyai.com/v3/ws?sample_rate=${this.config.sampleRate}&format_turns=true&speech_model=universal-streaming-multilingual&token=${token}`;
      console.log('[AssemblyAI] Connecting to WebSocket...');
      
      this.ws = new WebSocket(endpoint);

      this.ws.onopen = () => {
        console.log('[AssemblyAI] WebSocket connected');
        this.isRecording = true;
        this.onStatus?.('connected');
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          console.log('[AssemblyAI] Message received:', msg.type, msg);

          if (msg.type === 'Turn') {
            const { turn_order, transcript } = msg;
            if (transcript && transcript.trim()) {
              this.turns.set(turn_order, transcript);
              console.log(`[AssemblyAI] Turn ${turn_order}: "${transcript}"`);
              
              this.onTranscription?.({
                type: 'Turn',
                turn_order,
                transcript
              });
            }
          } else if (msg.type === 'PartialTranscript') {
            const text = msg.text || '';
            if (text.trim()) {
              this.onTranscription?.({
                type: 'PartialTranscript',
                transcript: text
              });
            }
          } else if (msg.type === 'FinalTranscript') {
            const text = msg.text || '';
            if (text.trim()) {
              this.onTranscription?.({
                type: 'FinalTranscript',
                transcript: text,
                confidence: msg.confidence
              });
            }
          } else if (msg.type === 'Begin') {
            // v3 API uses 'Begin' instead of 'SessionBegins'
            console.log('[AssemblyAI] Session started:', msg.id);
            this.onTranscription?.({
              type: 'SessionBegins',
              session_id: msg.id,
              transcript: ''
            });
          } else if (msg.type === 'SessionBegins') {
            console.log('[AssemblyAI] Session started:', msg.session_id);
            this.onTranscription?.({
              type: 'SessionBegins',
              session_id: msg.session_id,
              transcript: ''
            });
          } else if (msg.type === 'Error') {
            console.error('[AssemblyAI] Error from server:', msg.error);
            this.onTranscription?.({
              type: 'Error',
              error: msg.error,
              transcript: ''
            });
            this.onError?.(new Error(msg.error));
          }
        } catch (error) {
          console.error('[AssemblyAI] Failed to parse message:', error, event.data);
        }
      };

      this.ws.onerror = (event) => {
        console.error('[AssemblyAI] WebSocket error:', event);
        this.onError?.(new Error('WebSocket connection error'));
        this.onStatus?.('error');
      };

      this.ws.onclose = (event) => {
        console.log('[AssemblyAI] WebSocket closed:', event.code, event.reason);
        this.isRecording = false;
        this.onStatus?.('disconnected');
      };

    } catch (error) {
      console.error('[AssemblyAI] Start error:', error);
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.onStatus?.('error');
      throw error;
    }
  }

  /**
   * Stop real-time transcription
   */
  async stop(): Promise<void> {
    console.log('[AssemblyAI] Stopping... Audio chunks sent:', this.audioChunksSent);

    // Send terminate message
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'Terminate' }));
        console.log('[AssemblyAI] Terminate message sent');
      } catch (e) {
        console.warn('[AssemblyAI] Failed to send terminate:', e);
      }
      this.ws.close();
    }
    this.ws = null;

    // Stop AudioWorklet
    if (this.audioWorkletNode) {
      this.audioWorkletNode.disconnect();
      this.audioWorkletNode = null;
    }

    // Stop source
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    // Close AudioContext
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    // Stop media stream
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    // Clear audio buffer
    this.audioBufferQueue = new Int16Array(0);

    this.isRecording = false;
    this.onStatus?.('disconnected');
    console.log('[AssemblyAI] Stopped');
  }

  /**
   * Get all transcribed turns as ordered text
   */
  getFullTranscript(): string {
    const orderedTurns = Array.from(this.turns.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([_, text]) => text);
    return orderedTurns.join('\n');
  }

  /**
   * Clear all turns
   */
  clearTranscript(): void {
    this.turns.clear();
  }

  /**
   * Check if currently recording
   */
  getIsRecording(): boolean {
    return this.isRecording;
  }

  /**
   * Get number of audio chunks sent
   */
  getAudioChunksSent(): number {
    return this.audioChunksSent;
  }
}

/**
 * Create AssemblyAI service instance
 */
export function createAssemblyAIService(apiKey: string): AssemblyAIService {
  return new AssemblyAIService({ apiKey });
}
