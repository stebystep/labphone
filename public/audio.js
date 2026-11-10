/* exported LabAudio */
// Browser side of the audio path plus locally generated ringtone / ringback tones.
const LabAudio = (() => {
  let ctx = null;
  let node = null;
  let stream = null;
  let source = null;
  let sendFrame = null;
  let onLevels = null;
  let shouldSend = () => false;
  let toneTimer = null;
  let toneNodes = [];
  let micId = '';
  let spkId = '';

  async function enable({ send, levels, wantSend }) {
    sendFrame = send;
    onLevels = levels;
    shouldSend = wantSend;
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('audio-worklet.js');
    node = new AudioWorkletNode(ctx, 'labphone-audio', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (e) => {
      if (e.data.type === 'frame') { if (shouldSend()) sendFrame(e.data.pcm.buffer); }
      else if (e.data.type === 'levels' && onLevels) onLevels(e.data);
    };
    node.connect(ctx.destination);
    await openMic();
    if (spkId) await setSpeaker(spkId);
    if (ctx.state === 'suspended') await ctx.resume();
  }

  async function openMic() {
    if (source) source.disconnect();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    source = ctx.createMediaStreamSource(stream);
    source.connect(node);
  }

  async function disable() {
    stopTone();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) await ctx.close();
    ctx = node = stream = source = null;
  }

  function play(arrayBuffer) {
    if (!node) return;
    const pcm = new Int16Array(arrayBuffer);
    node.port.postMessage({ type: 'play', pcm }, [pcm.buffer]);
  }

  async function devices() {
    const list = await navigator.mediaDevices.enumerateDevices();
    return { inputs: list.filter((d) => d.kind === 'audioinput'), outputs: list.filter((d) => d.kind === 'audiooutput') };
  }

  async function setMic(id) { micId = id; if (ctx) await openMic(); }

  async function setSpeaker(id) {
    spkId = id;
    if (ctx && typeof ctx.setSinkId === 'function') await ctx.setSinkId(id || '');
  }

  // pattern: [[onMs, offMs], ...] repeated; freqs: array of Hz mixed together.
  function startTone(freqs, pattern, gain = 0.12) {
    stopTone();
    if (!ctx) return;
    let i = 0;
    const burst = () => {
      const [on, off] = pattern[i % pattern.length];
      i++;
      const g = ctx.createGain();
      g.gain.value = gain;
      g.connect(ctx.destination);
      const oscs = freqs.map((f) => { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(g); o.start(); o.stop(ctx.currentTime + on / 1000); return o; });
      toneNodes = oscs.concat([g]);
      toneTimer = setTimeout(burst, on + off);
    };
    burst();
  }

  function stopTone() {
    clearTimeout(toneTimer);
    toneTimer = null;
    for (const n of toneNodes) { try { n.disconnect(); } catch { /* gone */ } }
    toneNodes = [];
  }

  // Local feedback when a DTMF key is pressed: the real DTMF pair, quietly, for 120 ms.
  const DTMF_FREQ = {
    1: [697, 1209], 2: [697, 1336], 3: [697, 1477], 4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
    7: [852, 1209], 8: [852, 1336], 9: [852, 1477], '*': [941, 1209], 0: [941, 1336], '#': [941, 1477],
  };
  function keyBeep(k) {
    const f = DTMF_FREQ[k];
    if (!ctx || !f) return;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    g.connect(ctx.destination);
    for (const hz of f) {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      o.connect(g);
      o.start();
      o.stop(ctx.currentTime + 0.12);
    }
    setTimeout(() => g.disconnect(), 300);
  }

  return {
    enable, disable, play, devices, setMic, setSpeaker, keyBeep,
    get enabled() { return !!ctx; },
    ringtone: () => startTone([440, 480], [[400, 200], [400, 2000]], 0.18),
    ringback: () => startTone([425], [[1000, 4000]], 0.1),
    stopTone,
    get toneKind() { return toneTimer ? 'on' : null; },
  };
})();
