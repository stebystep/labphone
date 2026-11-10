/* global sampleRate, registerProcessor, AudioWorkletProcessor */
// Runs on the browser's audio thread.
//  capture:  mic (sampleRate, e.g. 48 kHz) -> boxcar low-pass + decimate -> 8 kHz Int16 frames of 160 samples
//  playback: 8 kHz Int16 frames from the network -> jitter buffer -> linear interpolation up to sampleRate
const FRAME = 160;
const RING = 8000 * 2; // 2 s of 8 kHz audio
const START_LEVEL = 480; // 60 ms buffered before playout starts
const MAX_LEVEL = 3200; // above 400 ms we drop audio to keep latency low

class LabPhoneAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = 8000 / sampleRate; // 8 kHz samples per output sample
    this.capPos = 0;
    this.capAcc = 0;
    this.capN = 0;
    this.frame = new Int16Array(FRAME);
    this.fi = 0;
    this.ring = new Float32Array(RING);
    this.w = 0;
    this.r = 0;
    this.frac = 0;
    this.level = 0;
    this.playing = false;
    this.micPeak = 0;
    this.spkPeak = 0;
    this.blocks = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'play') this.enqueue(d.pcm);
      else if (d.type === 'flush') { this.level = 0; this.r = this.w; this.playing = false; }
    };
  }

  enqueue(pcm) {
    for (let i = 0; i < pcm.length; i++) {
      this.ring[this.w] = pcm[i] / 32768;
      this.w = (this.w + 1) % RING;
    }
    this.level += pcm.length;
    if (this.level > MAX_LEVEL) {
      const drop = this.level - START_LEVEL * 2;
      this.r = (this.r + drop) % RING;
      this.level -= drop;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        const x = input[i];
        if (Math.abs(x) > this.micPeak) this.micPeak = Math.abs(x);
        this.capAcc += x;
        this.capN++;
        this.capPos += this.step;
        if (this.capPos >= 1) {
          this.capPos -= 1;
          const v = Math.max(-1, Math.min(1, this.capAcc / this.capN));
          this.capAcc = 0;
          this.capN = 0;
          this.frame[this.fi++] = Math.round(v * 32767);
          if (this.fi === FRAME) {
            this.port.postMessage({ type: 'frame', pcm: this.frame }, [this.frame.buffer]);
            this.frame = new Int16Array(FRAME);
            this.fi = 0;
          }
        }
      }
    }

    const out = outputs[0][0];
    if (!this.playing && this.level >= START_LEVEL) this.playing = true;
    for (let i = 0; i < out.length; i++) {
      if (!this.playing || this.level < 2) { out[i] = 0; this.playing = false; continue; }
      const a = this.ring[this.r];
      const b = this.ring[(this.r + 1) % RING];
      const s = a + (b - a) * this.frac;
      out[i] = s;
      if (Math.abs(s) > this.spkPeak) this.spkPeak = Math.abs(s);
      this.frac += this.step;
      while (this.frac >= 1) { this.frac -= 1; this.r = (this.r + 1) % RING; this.level--; }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);

    if (++this.blocks % 12 === 0) {
      this.port.postMessage({ type: 'levels', mic: this.micPeak, spk: this.spkPeak, buffered: this.level });
      this.micPeak = 0;
      this.spkPeak = 0;
    }
    return true;
  }
}

registerProcessor('labphone-audio', LabPhoneAudio);
