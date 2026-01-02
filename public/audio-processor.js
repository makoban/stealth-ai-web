/**
 * AudioWorklet Processor for AssemblyAI Streaming
 * 16kHz PCM audio data processing
 */

class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048; // Buffer size for accumulating samples
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    
    if (input.length > 0) {
      const inputChannel = input[0];
      
      // Accumulate samples into buffer
      for (let i = 0; i < inputChannel.length; i++) {
        this.buffer[this.bufferIndex++] = inputChannel[i];
        
        // When buffer is full, convert to Int16 and send
        if (this.bufferIndex >= this.bufferSize) {
          // Convert Float32 (-1.0 to 1.0) to Int16 (-32768 to 32767)
          const int16Buffer = new Int16Array(this.bufferSize);
          for (let j = 0; j < this.bufferSize; j++) {
            // Clamp value to -1.0 to 1.0 range
            const sample = Math.max(-1, Math.min(1, this.buffer[j]));
            // Convert to Int16
            int16Buffer[j] = sample < 0 
              ? sample * 0x8000 
              : sample * 0x7FFF;
          }
          
          // Send the audio data to the main thread
          this.port.postMessage({
            audio_data: int16Buffer
          });
          
          // Reset buffer
          this.bufferIndex = 0;
        }
      }
    }
    
    // Return true to keep the processor alive
    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
