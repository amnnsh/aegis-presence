// AudioWorklet for lib/audio.ts. Served from this origin because the CSP script-src does not allow blob: modules.
// It only measures and forwards samples to the page that owns the microphone; nothing is stored or sent anywhere.
class AegisCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.windowSize = Math.round(sampleRate / 100); // 10 ms loudness windows
    this.reset();
    this.port.onmessage = event => { this.recording = Boolean(event.data && event.data.recording); this.reset(); };
  }
  reset() { this.sum = 0; this.filled = 0; this.rms = []; this.pcm = []; this.firstWindowEnd = 0; }
  process(inputs) {
    const channels = inputs[0];
    if (!this.recording || !channels || !channels[0]) return true;
    const left = channels[0], right = channels[1];
    const block = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) {
      const sample = right ? (left[i] + right[i]) / 2 : left[i];
      block[i] = sample; this.sum += sample * sample;
      if (++this.filled === this.windowSize) {
        if (this.rms.length === 0) this.firstWindowEnd = (currentFrame + i + 1) / sampleRate;
        this.rms.push(Math.sqrt(this.sum / this.windowSize)); this.sum = 0; this.filled = 0;
      }
    }
    this.pcm.push(block);
    if (this.rms.length >= 10) { // about every 100 ms
      const length = this.pcm.reduce((total, chunk) => total + chunk.length, 0);
      const pcm = new Float32Array(length);
      let offset = 0;
      for (const chunk of this.pcm) { pcm.set(chunk, offset); offset += chunk.length; }
      this.port.postMessage({ firstWindowEnd: this.firstWindowEnd, sentAt: (currentFrame + left.length) / sampleRate, rms: Float32Array.from(this.rms), pcm }, [pcm.buffer]);
      this.rms = []; this.pcm = [];
    }
    return true;
  }
}
registerProcessor("aegis-capture", AegisCapture);
