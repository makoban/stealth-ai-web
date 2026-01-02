/**
 * AudioWorklet Processor for AssemblyAI Streaming
 * 16kHz PCM audio data processing
 * 
 * Based on official implementation:
 * https://github.com/AssemblyAI/realtime-transcription-browser-js-example
 */

const MAX_16BIT_INT = 32767;

class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
  }

  process(inputs, outputs, parameters) {
    try {
      const input = inputs[0];
      if (!input || input.length === 0) {
        return true;
      }

      const channelData = input[0];
      if (!channelData || channelData.length === 0) {
        return true;
      }

      // Convert Float32 (-1.0 to 1.0) to Int16 (-32768 to 32767)
      const float32Array = Float32Array.from(channelData);
      const int16Array = Int16Array.from(
        float32Array.map((n) => {
          // Clamp value to -1.0 to 1.0 range
          const clamped = Math.max(-1, Math.min(1, n));
          return Math.round(clamped * MAX_16BIT_INT);
        })
      );

      // Send the audio data buffer to the main thread
      this.port.postMessage({
        audio_data: int16Array.buffer
      });

      return true;
    } catch (error) {
      console.error('[AudioProcessor] Error:', error);
      return true;
    }
  }
}

registerProcessor('audio-processor', AudioProcessor);
