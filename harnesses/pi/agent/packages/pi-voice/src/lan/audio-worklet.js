class VoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.phase = 0; this.sum = 0; this.count = 0; this.samples = []; }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0; for (const channel of channels) value += channel[i] / channels.length;
      this.sum += value; this.count++; this.phase += 24000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        this.samples.push(Math.round(Math.max(-1, Math.min(1, this.sum / this.count)) * 32767));
        this.sum = 0; this.count = 0;
        if (this.samples.length === 480) {
          const pcm = new ArrayBuffer(960); const view = new DataView(pcm);
          this.samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
          this.port.postMessage(pcm, [pcm]); this.samples = [];
        }
      }
    }
    return true;
  }
}
registerProcessor("voice-capture", VoiceCapture);
