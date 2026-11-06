#!/usr/bin/env node
// Renders the 20-second original score for the Frameyard intro.
//
// The score is synthesized from scratch so the example stays self-contained:
// no samples, no model downloads, no licensing questions. Every random choice
// comes from a fixed-seed LCG, so regenerating the WAV is deterministic.
//
// Structure (120 BPM, D minor -> D major), aligned with the scene cuts:
//   0.0 – 4.5   author:    sub drone, heartbeat kick, air
//   4.5 – 9.5   compose:   Bb pad, plucked arpeggio, hats
//   9.5 – 14.5  render:    F pad, four-on-the-floor, riser
//  14.5 – 20.0  frameyard: D major, impact, shimmer, tail
//
// The WAV synthesis is deterministic. The default Ogg Vorbis encode uses
// ffmpeg's libvorbis at q6 with bitexact flags, so the same toolchain
// reproduces the same bytes.
//
// Run from anywhere:
//   node examples/intro/scripts/make-score.mjs
//   node examples/intro/scripts/make-score.mjs /tmp/score.ogg
//   node examples/intro/scripts/make-score.mjs /tmp/score.wav

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, "..", "assets", "score.ogg");

const SR = 48000;
const DURATION = 20;
const TAIL = 2.5;
const N = Math.ceil((DURATION + TAIL) * SR);
const OUT = Math.round(DURATION * SR);
const TAU = Math.PI * 2;
const BPM = 120;
const BEAT = 60 / BPM;

let seed = 0x51ed270b;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
}
function noise() {
  return random() * 2 - 1;
}

function hz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
function smoothstep(value) {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}
function envelope(t, duration, attack, release) {
  if (t < 0 || t > duration) {
    return 0;
  }
  return smoothstep(t / attack) * smoothstep((duration - t) / release);
}
function panGains(pan) {
  const p = (Math.max(-1, Math.min(1, pan)) + 1) / 2;
  return [Math.cos(p * Math.PI * 0.5), Math.sin(p * Math.PI * 0.5)];
}

// Buses. Pad and bass are filtered after the notes are rendered; percussion,
// arpeggio, and effects stay mostly dry with selected reverb sends.
const padL = new Float64Array(N);
const padR = new Float64Array(N);
const bassL = new Float64Array(N);
const bassR = new Float64Array(N);
const arpL = new Float64Array(N);
const arpR = new Float64Array(N);
const percL = new Float64Array(N);
const percR = new Float64Array(N);
const fxL = new Float64Array(N);
const fxR = new Float64Array(N);
const revSend = new Float64Array(N);
const delaySend = new Float64Array(N);
const duck = new Float64Array(N).fill(1);

function addPadNote(start, duration, midi, gain, pan, brightness = 1) {
  const frequency = hz(midi);
  const length = Math.round(duration * SR);
  const startIndex = Math.round(start * SR);
  const [gainL, gainR] = panGains(pan);
  const detunes = [-0.0055, 0, 0.0055];
  const harmonics = brightness > 1 ? 6 : 5;

  for (const detune of detunes) {
    const voiceFrequency = frequency * (1 + detune);
    let phase = random() * TAU;
    let lfoPhase = random() * TAU;
    const voicePan = pan + (detune < 0 ? -0.08 : detune > 0 ? 0.08 : 0);
    const [voiceL, voiceR] = panGains(voicePan);
    for (let i = 0; i < length; i += 1) {
      const index = startIndex + i;
      if (index < 0 || index >= N) {
        break;
      }
      const t = i / SR;
      const env = envelope(t, duration, 0.85, 1.35);
      const breath = 0.84 + 0.16 * Math.sin(lfoPhase + t * 0.62);
      phase += (TAU * voiceFrequency) / SR;
      if (phase > TAU) {
        phase -= TAU;
      }
      let sample = 0;
      for (let harmonic = 1; harmonic <= harmonics; harmonic += 1) {
        sample += Math.sin(phase * harmonic) / Math.pow(harmonic, 1.72);
      }
      sample *= gain * env * breath;
      padL[index] += sample * gainL * voiceL;
      padR[index] += sample * gainR * voiceR;
      revSend[index] += sample * 0.05;
    }
  }
}

function addSub(start, duration, midi, gain) {
  const frequency = hz(midi);
  const length = Math.round(duration * SR);
  const startIndex = Math.round(start * SR);
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const index = startIndex + i;
    if (index < 0 || index >= N) {
      break;
    }
    const t = i / SR;
    const env = envelope(t, duration, 0.9, 1.6);
    phase += (TAU * frequency) / SR;
    if (phase > TAU) {
      phase -= TAU;
    }
    const sample = (Math.sin(phase) + 0.18 * Math.sin(phase * 2)) * env * gain;
    bassL[index] += sample;
    bassR[index] += sample;
  }
}

function addBassNote(start, duration, midi, gain) {
  const frequency = hz(midi);
  const length = Math.round(duration * SR);
  const startIndex = Math.round(start * SR);
  let phase = random() * TAU;
  for (let i = 0; i < length; i += 1) {
    const index = startIndex + i;
    if (index < 0 || index >= N) {
      break;
    }
    const t = i / SR;
    const env = envelope(t, duration, 0.008, 0.06) * Math.exp(-t * 3.2);
    phase += (TAU * frequency) / SR;
    if (phase > TAU) {
      phase -= TAU;
    }
    const sample = (Math.sin(phase) + 0.42 * Math.sin(phase * 2) + 0.16 * Math.sin(phase * 3)) * env * gain;
    bassL[index] += sample;
    bassR[index] += sample;
  }
}

function addKick(start, gain, decay = 0.42, startPitch = 112, endPitch = 42) {
  const length = Math.round((decay * 5.5 + 0.08) * SR);
  const startIndex = Math.round(start * SR);
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const index = startIndex + i;
    if (index < 0 || index >= N) {
      break;
    }
    const t = i / SR;
    const frequency = endPitch + (startPitch - endPitch) * Math.exp(-t * 17);
    phase += (TAU * frequency) / SR;
    if (phase > TAU) {
      phase -= TAU;
    }
    const body = Math.sin(phase) * Math.exp(-t / decay) * (1 - Math.exp(-t * 320));
    const click = noise() * Math.exp(-t * 95) * 0.08;
    const sample = (body + click) * gain;
    percL[index] += sample;
    percR[index] += sample;
    revSend[index] += sample * 0.04;
  }

  const duckStart = Math.round(start * SR);
  for (let i = 0; i < Math.round(0.42 * SR); i += 1) {
    const index = duckStart + i;
    if (index < 0 || index >= N) {
      break;
    }
    const t = i / SR;
    duck[index] = Math.max(0.4, duck[index] * (1 - 0.24 * Math.exp(-t * 10) * (1 - Math.exp(-t * 110))));
  }
}

function addHat(start, gain, decay = 0.035, pan = 0.25, tone = 0.8) {
  const length = Math.round((decay * 6 + 0.01) * SR);
  const startIndex = Math.round(start * SR);
  const [gainL, gainR] = panGains(pan);
  let previousInput = 0;
  let previousOutput = 0;
  const coefficient = 0.58;
  for (let i = 0; i < length; i += 1) {
    const index = startIndex + i;
    if (index < 0 || index >= N) {
      break;
    }
    const t = i / SR;
    const input = noise();
    const highpassed = coefficient * (previousOutput + input - previousInput);
    previousInput = input;
    previousOutput = highpassed;
    const metallic = Math.sin(TAU * 9100 * t) * 0.18 * tone;
    const sample = (highpassed + metallic) * Math.exp(-t / decay) * gain;
    percL[index] += sample * gainL;
    percR[index] += sample * gainR;
  }
}

function addClap(start, gain, pan = 0) {
  const [gainL, gainR] = panGains(pan);
  const bursts = [0, 0.012, 0.026];
  for (const offset of bursts) {
    const startIndex = Math.round((start + offset) * SR);
    const length = Math.round(0.22 * SR);
    let low = 0;
    let band = 0;
    for (let i = 0; i < length; i += 1) {
      const index = startIndex + i;
      if (index < 0 || index >= N) {
        break;
      }
      const t = i / SR;
      const f = 2 * Math.sin((Math.PI * 1650) / SR);
      low += f * band;
      const high = noise() - low - 1.1 * band;
      band += f * high;
      const sample = band * Math.exp(-t * 34) * gain;
      percL[index] += sample * gainL;
      percR[index] += sample * gainR;
      revSend[index] += sample * 0.12;
    }
  }
}

function addPluck(start, duration, midi, gain, pan) {
  const frequency = hz(midi);
  const length = Math.round(duration * SR);
  const startIndex = Math.round(start * SR);
  const [gainL, gainR] = panGains(pan);
  let phase = random() * TAU;
  for (let i = 0; i < length; i += 1) {
    const index = startIndex + i;
    if (index < 0 || index >= N) {
      break;
    }
    const t = i / SR;
    const env = (1 - Math.exp(-t * 260)) * Math.exp(-t * 9.5);
    phase += (TAU * frequency) / SR;
    if (phase > TAU) {
      phase -= TAU;
    }
    const sample = (Math.sin(phase) + 0.36 * Math.sin(phase * 2) + 0.13 * Math.sin(phase * 3)) * env * gain;
    arpL[index] += sample * gainL;
    arpR[index] += sample * gainR;
    delaySend[index] += sample * 0.8;
    revSend[index] += sample * 0.16;
  }
}

function addRiser(start, duration, gain) {
  const length = Math.round(duration * SR);
  const startIndex = Math.round(start * SR);
  let low = 0;
  let band = 0;
  let sweepPhase = 0;
  for (let i = 0; i < length; i += 1) {
    const index = startIndex + i;
    if (index < 0 || index >= N) {
      break;
    }
    const t = i / SR;
    const progress = t / duration;
    const cutoff = 240 * Math.pow(28, progress);
    const f = Math.min(1.6, 2 * Math.sin((Math.PI * cutoff) / SR));
    low += f * band;
    const high = noise() - low - 1.35 * band;
    band += f * high;
    const sweepFrequency = 180 * Math.pow(7, progress);
    sweepPhase += (TAU * sweepFrequency) / SR;
    if (sweepPhase > TAU) {
      sweepPhase -= TAU;
    }
    const env = Math.pow(progress, 2.2) * Math.min(1, (duration - t) / 0.035);
    const sample = (band * 0.8 + Math.sin(sweepPhase) * 0.18) * env * gain;
    const pan = -0.55 + progress * 1.1;
    const [gainL, gainR] = panGains(pan);
    fxL[index] += sample * gainL;
    fxR[index] += sample * gainR;
    revSend[index] += sample * 0.3;
  }
}

function addImpact(start, gain) {
  addKick(start, gain, 1.15, 86, 28);
  const length = Math.round(1.4 * SR);
  const startIndex = Math.round(start * SR);
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const index = startIndex + i;
    if (index < 0 || index >= N) {
      break;
    }
    const t = i / SR;
    const env = Math.exp(-t * 2.6) * (1 - Math.exp(-t * 180));
    phase += (TAU * 58) / SR;
    if (phase > TAU) {
      phase -= TAU;
    }
    const ring = Math.sin(phase) * 0.5 + Math.sin(phase * 3) * 0.08;
    const sample = ring * env * gain * 0.4;
    fxL[index] += sample;
    fxR[index] += sample;
    revSend[index] += sample * 0.5;
  }

  const noiseLength = Math.round(0.5 * SR);
  for (let i = 0; i < noiseLength; i += 1) {
    const index = startIndex + i;
    if (index < 0 || index >= N) {
      break;
    }
    const t = i / SR;
    const sample = noise() * Math.exp(-t * 16) * gain * 0.16;
    fxL[index] += sample;
    fxR[index] += sample;
    revSend[index] += sample * 0.6;
  }
}

function addAirNote(start, duration, midi, gain, pan) {
  const frequency = hz(midi);
  const length = Math.round(duration * SR);
  const startIndex = Math.round(start * SR);
  const [gainL, gainR] = panGains(pan);
  let phase = random() * TAU;
  let phase2 = random() * TAU;
  for (let i = 0; i < length; i += 1) {
    const index = startIndex + i;
    if (index < 0 || index >= N) {
      break;
    }
    const t = i / SR;
    const env = envelope(t, duration, 1.15, 3.4);
    phase += (TAU * frequency) / SR;
    phase2 += (TAU * frequency * 1.004) / SR;
    if (phase > TAU) phase -= TAU;
    if (phase2 > TAU) phase2 -= TAU;
    const sample = (Math.sin(phase) * 0.72 + Math.sin(phase2) * 0.28) * env * gain;
    arpL[index] += sample * gainL;
    arpR[index] += sample * gainR;
    revSend[index] += sample * 0.4;
  }
}

// ---------------------------------------------------------------------------
// Arrangement
// ---------------------------------------------------------------------------

const chords = [
  { start: 0, end: 5.0, notes: [38, 45, 50, 53, 57], root: 26, gain: 0.009 },
  { start: 4.2, end: 9.8, notes: [34, 41, 46, 50, 53], root: 22, gain: 0.01 },
  { start: 9.2, end: 14.8, notes: [29, 36, 41, 45, 48], root: 17, gain: 0.011 },
  { start: 14.2, end: 20.5, notes: [38, 45, 50, 54, 57, 62], root: 26, gain: 0.011 },
];

for (const chord of chords) {
  const duration = chord.end - chord.start + 0.9;
  chord.notes.forEach((note, index) => {
    const pan = chord.notes.length === 1 ? 0 : (index / (chord.notes.length - 1) - 0.5) * 0.62;
    addPadNote(chord.start, duration, note, chord.gain, pan, 1.2);
  });
  addSub(chord.start, chord.end - chord.start + 0.35, chord.root, 0.025);
}

// Heartbeat and groove.
addImpact(0.02, 0.4);
for (const time of [1.0, 2.0, 3.0, 4.0]) {
  addKick(time, 0.24, 0.28, 92, 46);
}
for (const time of [4.5, 5.5, 6.5, 7.5, 8.5]) {
  addKick(time, 0.55, 0.34, 108, 44);
}
for (let time = 9.5; time < 14.5; time += 0.5) {
  addKick(time, time === 9.5 || time === 13.5 ? 0.72 : 0.56, 0.34, 108, 44);
}
addImpact(4.5, 0.5);
addImpact(9.5, 0.68);
addImpact(14.5, 0.95);
addImpact(15.15, 0.32);

// Hats: sparse before the lift, driving in the middle.
for (let time = 4.5, index = 0; time < 14.5; time += 0.25, index += 1) {
  const accent = index % 4 === 2 ? 0.32 : 0.2;
  addHat(time, accent, index % 4 === 2 ? 0.07 : 0.035, index % 2 === 0 ? -0.28 : 0.3, 0.9);
}
for (let time = 9.5; time < 14.5; time += 0.5) {
  addClap(time + 0.25, 0.3, 0);
}

// Bass pulses follow the chord roots. The offbeats are softer.
const bassPattern = [
  { at: 0, length: 0.24, gain: 0.06 },
  { at: 0.25, length: 0.2, gain: 0.038 },
  { at: 0.375, length: 0.12, gain: 0.024 },
];
for (let time = 4.5; time < 14.5; time += 0.5) {
  const chord = chords.find((entry) => time >= entry.start && time < entry.end) ?? chords[chords.length - 1];
  for (const pulse of bassPattern) {
    const at = time + pulse.at;
    if (at < 14.5) {
      addBassNote(at, pulse.length, chord.root + 12, pulse.gain);
    }
  }
}

// Plucked arpeggio. The pattern changes register at the lift.
const arpPattern = [0, 2, 4, 3, 2, 4, 1, 3];
for (let time = 4.5, index = 0; time < 14.5; time += 0.25, index += 1) {
  const chord = chords.find((entry) => time >= entry.start && time < entry.end) ?? chords[chords.length - 1];
  const note = chord.notes[arpPattern[index % arpPattern.length] % chord.notes.length] + 12;
  const lift = time >= 9.5 ? 1 : 0;
  addPluck(time, 0.62, note + lift * 12, time >= 9.5 ? 0.15 : 0.13, index % 2 === 0 ? -0.34 : 0.34);
  if (time >= 9.5 && index % 4 === 3) {
    addPluck(time + 0.125, 0.3, note + 24, 0.05, 0.1);
  }
}

// Risers and transition air.
addRiser(2.4, 2.0, 0.16);
addRiser(7.1, 2.3, 0.2);
addRiser(12.0, 2.4, 0.28);

// Resolution: high air chord, sparkles, and a low final swell.
const airNotes = [74, 78, 81, 86, 90];
airNotes.forEach((note, index) => {
  addAirNote(14.55, 5.1, note, 0.026, (index / (airNotes.length - 1) - 0.5) * 1.2);
});
const sparkleNotes = [98, 93, 90, 98, 95, 102];
const sparkleTimes = [15.4, 16.1, 16.9, 17.7, 18.4, 19.0];
sparkleTimes.forEach((time, index) => {
  addPluck(time, 1.3, sparkleNotes[index], 0.05, index % 2 === 0 ? -0.66 : 0.66);
  revSend[Math.round(time * SR)] += 0.02;
});
addSub(17.6, 2.5, 26, 0.055);
addAirNote(17.9, 2.4, 62, 0.022, 0);
addAirNote(17.9, 2.4, 69, 0.018, -0.4);

// ---------------------------------------------------------------------------
// Filters and mixing
// ---------------------------------------------------------------------------

function lowpassBus(input, cutoffAt, q = 1.0) {
  const output = new Float64Array(N);
  let low = 0;
  let band = 0;
  for (let i = 0; i < N; i += 1) {
    const cutoff = Math.max(40, Math.min(0.42 * SR, cutoffAt(i / SR)));
    const f = 2 * Math.sin((Math.PI * cutoff) / SR);
    low += f * band;
    const high = input[i] - low - q * band;
    band += f * high;
    output[i] = low;
  }
  return output;
}

function highpassBus(input, cutoff) {
  const output = new Float64Array(N);
  const rc = 1 / (TAU * cutoff);
  const alpha = rc / (rc + 1 / SR);
  let previousInput = 0;
  let previousOutput = 0;
  for (let i = 0; i < N; i += 1) {
    const value = input[i];
    previousOutput = alpha * (previousOutput + value - previousInput);
    previousInput = value;
    output[i] = previousOutput;
  }
  return output;
}

function padCutoff(t) {
  if (t < 4.5) {
    return 420 + (t / 4.5) * 380;
  }
  if (t < 9.5) {
    return 800 + ((t - 4.5) / 5) * 1000;
  }
  if (t < 14.5) {
    return 1800 + ((t - 9.5) / 5) * 3000;
  }
  return 4800 * Math.pow(0.22, Math.min(1, (t - 14.5) / 5.2));
}

function bassCutoff(t) {
  return 180 + 60 * Math.sin(Math.min(1, t / 20) * Math.PI);
}

const padFilteredL = highpassBus(lowpassBus(padL, padCutoff, 0.9), 75);
const padFilteredR = highpassBus(lowpassBus(padR, padCutoff, 0.9), 75);
const bassFilteredL = lowpassBus(bassL, bassCutoff, 0.7);
const bassFilteredR = lowpassBus(bassR, bassCutoff, 0.7);

// Simple stereo Schroeder reverb. Four damped combs feed two allpasses per
// channel; different delay lengths keep the tail wide without a convolver.
function reverb(input) {
  const left = new Float64Array(N);
  const right = new Float64Array(N);

  function channel(target, lengths, spread) {
    const combs = lengths.map((seconds, index) => ({
      buffer: new Float64Array(Math.max(1, Math.round(seconds * SR))),
      index: 0,
      damp: 0,
      feedback: 0.76 - index * 0.025,
    }));
    const allpasses = [0.0051 * spread, 0.0017 * spread].map((seconds) => ({
      buffer: new Float64Array(Math.max(1, Math.round(seconds * SR))),
      index: 0,
    }));
    const combMix = new Float64Array(N);
    for (let i = 0; i < N; i += 1) {
      let sum = 0;
      for (const comb of combs) {
        const delayed = comb.buffer[comb.index];
        comb.damp = delayed * 0.62 + comb.damp * 0.38;
        comb.buffer[comb.index] = input[i] + comb.damp * comb.feedback;
        comb.index = (comb.index + 1) % comb.buffer.length;
        sum += delayed;
      }
      combMix[i] = sum / combs.length;
    }
    let signal = combMix;
    for (const allpass of allpasses) {
      const next = new Float64Array(N);
      for (let i = 0; i < N; i += 1) {
        const delayed = allpass.buffer[allpass.index];
        next[i] = -signal[i] + delayed;
        allpass.buffer[allpass.index] = signal[i] + delayed * 0.5;
        allpass.index = (allpass.index + 1) % allpass.buffer.length;
      }
      signal = next;
    }
    target.set(signal);
  }

  channel(left, [0.0297, 0.0371, 0.0411, 0.0437], 1);
  channel(right, [0.0311, 0.0389, 0.0427, 0.0451], 1.03);
  return { left, right };
}

// Ping-pong delay for the arpeggio: dotted eighth, filtered feedback.
function pingPong(input, delaySeconds, feedback = 0.34) {
  const left = new Float64Array(N);
  const right = new Float64Array(N);
  const delay = Math.max(1, Math.round(delaySeconds * SR));
  const bufferLeft = new Float64Array(N);
  const bufferRight = new Float64Array(N);
  for (let i = 0; i < N; i += 1) {
    const readLeft = i >= delay ? bufferRight[i - delay] : 0;
    const readRight = i >= delay ? bufferLeft[i - delay] : 0;
    bufferLeft[i] = input[i] + readLeft * feedback;
    bufferRight[i] = readRight * feedback;
    left[i] = i >= delay ? bufferLeft[i - delay] * 0.9 : 0;
    right[i] = i >= delay ? bufferRight[i - delay] * 0.9 : 0;
  }
  return { left, right };
}

const reverbInput = new Float64Array(N);
for (let i = 0; i < N; i += 1) {
  reverbInput[i] = revSend[i] + (fxL[i] + fxR[i]) * 0.22;
}
const wet = reverb(reverbInput);
const delay = pingPong(delaySend, BEAT * 0.75, 0.36);

const mixL = new Float64Array(OUT);
const mixR = new Float64Array(OUT);
for (let i = 0; i < OUT; i += 1) {
  const padGain = duck[i];
  const bassGain = duck[i];
  const dryL = padFilteredL[i] * padGain + bassFilteredL[i] * bassGain + arpL[i] + percL[i] + fxL[i];
  const dryR = padFilteredR[i] * padGain + bassFilteredR[i] * bassGain + arpR[i] + percR[i] + fxR[i];
  mixL[i] = dryL + wet.left[i] * 0.72 + delay.left[i] * 0.24;
  mixR[i] = dryR + wet.right[i] * 0.72 + delay.right[i] * 0.24;
}

// Master: DC/rumble removal, gentle saturation, normalization, fades.
function highpass(input, cutoff) {
  const rc = 1 / (TAU * cutoff);
  const alpha = rc / (rc + 1 / SR);
  let previousInput = 0;
  let previousOutput = 0;
  for (let i = 0; i < OUT; i += 1) {
    const value = input[i];
    previousOutput = alpha * (previousOutput + value - previousInput);
    previousInput = value;
    input[i] = previousOutput;
  }
}

highpass(mixL, 24);
highpass(mixR, 24);

for (let i = 0; i < OUT; i += 1) {
  mixL[i] = Math.tanh(mixL[i] * 1.08);
  mixR[i] = Math.tanh(mixR[i] * 1.08);
}

let peak = 0;
for (let i = 0; i < OUT; i += 1) {
  peak = Math.max(peak, Math.abs(mixL[i]), Math.abs(mixR[i]));
}
const normalize = peak > 0 ? 0.72 / peak : 1;
const fadeIn = Math.round(0.04 * SR);
const fadeOutStart = Math.round(19.25 * SR);
for (let i = 0; i < OUT; i += 1) {
  const fade = smoothstep(i / fadeIn) * smoothstep((OUT - i) / (OUT - fadeOutStart));
  mixL[i] *= normalize * fade;
  mixR[i] *= normalize * fade;
}

// 16-bit PCM WAV with TPDF dither.
const bytes = 44 + OUT * 4;
const wav = Buffer.alloc(bytes);
wav.write("RIFF", 0, "ascii");
wav.writeUInt32LE(36 + OUT * 4, 4);
wav.write("WAVE", 8, "ascii");
wav.write("fmt ", 12, "ascii");
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(SR, 24);
wav.writeUInt32LE(SR * 4, 28);
wav.writeUInt16LE(4, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36, "ascii");
wav.writeUInt32LE(OUT * 4, 40);

let offset = 44;
for (let i = 0; i < OUT; i += 1) {
  for (const value of [mixL[i], mixR[i]]) {
    const dither = (random() - random()) / 65536;
    const sample = Math.max(-1, Math.min(1, value + dither));
    wav.writeInt16LE(Math.round(sample * 32767), offset);
    offset += 2;
  }
}

mkdirSync(path.dirname(out), { recursive: true });
if (out.endsWith(".wav")) {
  writeFileSync(out, wav);
} else {
  const work = mkdtempSync(path.join(tmpdir(), "frameyard-score-"));
  const master = path.join(work, "score.wav");
  try {
    writeFileSync(master, wav);
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-fflags",
        "+bitexact",
        "-i",
        master,
        "-map_metadata",
        "-1",
        "-c:a",
        "libvorbis",
        "-q:a",
        "6",
        "-fflags",
        "+bitexact",
        out,
      ],
      { stdio: "inherit" },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
const size = statSync(out).size;
console.log(
  `wrote ${path.relative(process.cwd(), out)} (${(size / 1024).toFixed(0)} KiB, peak ${(20 * Math.log10(0.72)).toFixed(1)} dBFS)`,
);
