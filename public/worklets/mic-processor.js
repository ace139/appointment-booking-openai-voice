// Minimal AudioWorkletProcessor that copies input audio frames to the main thread.
// We copy into a new Float32Array to avoid transferring engine-owned buffers.

class MicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs && inputs[0] && inputs[0][0];
    if (input && input.length) {
      const copy = new Float32Array(input.length);
      copy.set(input);
      // Transfer underlying buffer to avoid extra copy in main thread.
      this.port.postMessage({ buffer: copy.buffer }, [copy.buffer]);
    }
    // Keep processor alive
    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);

