'use strict';
// G.711 mu-law (PCMU) and A-law (PCMA) companding, ITU-T G.711.

const BIAS = 0x84;
const CLIP = 32635;

function linearToUlaw(sample) {
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function ulawToLinear(byte) {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let s = ((mantissa << 3) + BIAS) << exponent;
  s -= BIAS;
  return sign ? -s : s;
}

function linearToAlaw(sample) {
  let s = sample;
  let mask;
  if (s >= 0) { mask = 0xd5; } else { mask = 0x55; s = -s - 1; }
  if (s > 32767) s = 32767;
  let seg = 0;
  const ends = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];
  while (seg < 8 && s > ends[seg]) seg++;
  if (seg >= 8) return 0x7f ^ mask;
  let aval = seg << 4;
  aval |= seg < 2 ? (s >> 4) & 0x0f : (s >> (seg + 3)) & 0x0f;
  return aval ^ mask;
}

function alawToLinear(byte) {
  const a = byte ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else { t += 0x108; t <<= seg - 1; }
  return a & 0x80 ? t : -t;
}

// Lookup tables make decoding a single array read per sample.
const ULAW_DEC = new Int16Array(256);
const ALAW_DEC = new Int16Array(256);
for (let i = 0; i < 256; i++) { ULAW_DEC[i] = ulawToLinear(i); ALAW_DEC[i] = alawToLinear(i); }
const ULAW_ENC = new Uint8Array(65536);
const ALAW_ENC = new Uint8Array(65536);
for (let i = -32768; i < 32768; i++) { ULAW_ENC[i & 0xffff] = linearToUlaw(i); ALAW_ENC[i & 0xffff] = linearToAlaw(i); }

function encode(name, pcm /* Int16Array */) {
  const table = name === 'PCMA' ? ALAW_ENC : ULAW_ENC;
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = table[pcm[i] & 0xffff];
  return out;
}

function decode(name, payload /* Buffer */) {
  const table = name === 'PCMA' ? ALAW_DEC : ULAW_DEC;
  const out = new Int16Array(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = table[payload[i]];
  return out;
}

const SILENCE = { PCMU: 0xff, PCMA: 0xd5 };

module.exports = { encode, decode, linearToUlaw, ulawToLinear, linearToAlaw, alawToLinear, SILENCE };
