/**
 * Offline stem renderer: each stem of a song is rendered once into an AudioBuffer (an OfflineAudioContext
 * runs the synths faster than real time, off the main thread), with the reverb and echo tails folded back
 * onto the loop start so it repeats without a seam. Playback then costs one buffer source per stem.
 */
import { foldTail, impulseResponse, noise, normalizeGain, rng } from '../dsp';
import { arp, bass, drum, lead, pad, type Rig } from './instruments';
import { BARS, loopSamples, STEPS_PER_BAR, type Song, type StemName } from './songs';

export type OfflineFactory = (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

export interface StemFormat {
  sampleRate: number;
  channels: 1 | 2;
}

/** Stem formats per audio tier: full = stereo at the device rate; lite = mono at 24 kHz (≈¼ the memory). */
export function stemFormat(lite: boolean, deviceRate: number): StemFormat {
  return lite ? { sampleRate: 24000, channels: 1 } : { sampleRate: deviceRate, channels: 2 };
}

/** Reverb / echo tail rendered past the loop end and folded back (s). */
const TAIL = 3;

/** Per-stem loudness (RMS dBFS) after rendering: the stems' balance, the same in every song. */
export const STEM_RMS_DB: Readonly<Record<StemName, number>> = { pad: -25, bass: -23, arp: -28, beat: -21, perc: -31, lead: -25 };
/** Reverb send per stem, scaled by the song's `space.reverb`. */
const STEM_SEND: Record<StemName, number> = { pad: 0.9, bass: 0.05, arp: 0.6, beat: 0.25, perc: 0.35, lead: 0.7 };

function toBuffer(ctx: BaseAudioContext, data: Float32Array<ArrayBuffer>[], sampleRate: number): AudioBuffer {
  const buf = ctx.createBuffer(data.length, data[0]!.length, sampleRate);
  data.forEach((d, c) => buf.copyToChannel(d, c));
  return buf;
}

/** Renders one stem of `song` as a seamless loop. */
export async function renderStem(song: Song, stem: StemName, fmt: StemFormat, offline: OfflineFactory): Promise<AudioBuffer> {
  const loop = loopSamples(song, fmt.sampleRate);
  const ctx = offline(fmt.channels, loop + Math.round(TAIL * fmt.sampleRate), fmt.sampleRate);
  const stepSec = loop / fmt.sampleRate / (BARS * STEPS_PER_BAR);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const rig: Rig = { ctx, noise: toBuffer(ctx, [noise(Math.round(fmt.sampleRate * 2.5), 'white', 11)], fmt.sampleRate), out };

  // a ping-pong echo on the melodic stems (the hall is rendered once for the whole song: renderSpace)
  if ((stem === 'arp' || stem === 'lead') && song.space.delayMix > 0) {
    const dt = song.space.delaySteps * stepSec;
    const dl = ctx.createDelay(2);
    const dr = ctx.createDelay(2);
    dl.delayTime.value = dt;
    dr.delayTime.value = dt;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3200;
    const wet = ctx.createGain();
    wet.gain.value = song.space.delayMix;
    out.connect(wet).connect(dl);
    dl.connect(dr);
    dr.connect(tone).connect(fb).connect(dl);
    if (fmt.channels === 2 && typeof ctx.createChannelMerger === 'function') {
      const m = ctx.createChannelMerger(2);
      dl.connect(m, 0, 0);
      dr.connect(m, 0, 1);
      m.connect(ctx.destination);
    } else {
      dl.connect(ctx.destination);
      dr.connect(ctx.destination);
    }
  }

  // light humanisation: ±4 ms on the tops, ±6 % velocity, deterministic per stem
  const r = rng(song.bpm * 31 + stem.length * 7);
  const human = (s: number): number => (stem === 'perc' || stem === 'arp' ? (r() - 0.5) * 0.008 : 0) + s * stepSec;
  if (stem === 'beat' || stem === 'perc') {
    for (const e of song.drums[stem]) drum(rig, song.voices.kit, e.kind, Math.max(0, human(e.step)), e.vel * (0.94 + 0.12 * r()));
  } else {
    for (const e of song.notes[stem]) {
      const t = Math.max(0, human(e.step));
      const dur = e.len * stepSec;
      const vel = e.vel * (0.94 + 0.12 * r());
      if (stem === 'pad') pad(rig, song.voices.pad, t, e.midi, dur, vel);
      else if (stem === 'bass') bass(rig, song.voices.bass, t, e.midi, dur, vel);
      else if (stem === 'arp') arp(rig, song.voices.arp, t, e.midi, dur, vel);
      else lead(rig, song.voices.lead, t, e.midi, dur, vel);
    }
  }

  const rendered = await ctx.startRendering();
  const chans: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < rendered.numberOfChannels; c++) chans.push(foldTail(rendered.getChannelData(c), loop));
  // every song's stems land at the same loudness per role, so the director's layer mix means the same everywhere
  const k = normalizeGain(chans, STEM_RMS_DB[stem]);
  for (const d of chans) for (let i = 0; i < d.length; i++) d[i]! *= k;
  return toBuffer(ctx, chans, fmt.sampleRate);
}

/** Reverb send of each stem into the song's hall (× the song's `space.reverb`). */
export function spaceSend(stem: StemName, reverb: number): number {
  return STEM_SEND[stem] * reverb;
}

/**
 * The song's hall: every rendered dry stem, at its send level, through one convolution pass (one pass for
 * the whole song instead of one per stem). Plays as its own layer, scaled by the layers that feed it.
 */
export async function renderSpace(song: Song, stems: Partial<Record<StemName, AudioBuffer>>, fmt: StemFormat, offline: OfflineFactory): Promise<AudioBuffer> {
  const loop = loopSamples(song, fmt.sampleRate);
  const ctx = offline(fmt.channels, loop + Math.round(TAIL * fmt.sampleRate), fmt.sampleRate);
  const [l, r] = impulseResponse('hall', fmt.sampleRate, 1, 23);
  const conv = ctx.createConvolver();
  conv.normalize = false;
  conv.buffer = toBuffer(ctx, fmt.channels === 2 ? [l, r] : [l], fmt.sampleRate);
  conv.connect(ctx.destination);
  for (const [name, buf] of Object.entries(stems) as [StemName, AudioBuffer][]) {
    const send = spaceSend(name, song.space.reverb);
    if (send < 0.01) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = send;
    src.connect(g).connect(conv);
    src.start(0);
  }
  const rendered = await ctx.startRendering();
  const chans: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < rendered.numberOfChannels; c++) chans.push(foldTail(rendered.getChannelData(c), loop));
  return toBuffer(ctx, chans, fmt.sampleRate);
}

/** Renders every stem of `song`, one after another (keeps the render thread's peak memory low). */
export async function renderSong(song: Song, stems: readonly StemName[], fmt: StemFormat, offline: OfflineFactory): Promise<Partial<Record<StemName, AudioBuffer>>> {
  const out: Partial<Record<StemName, AudioBuffer>> = {};
  for (const s of stems) out[s] = await renderStem(song, s, fmt, offline);
  return out;
}

/** Bytes a rendered stem set takes (Float32 PCM). */
export function stemBytes(song: Song, stems: number, fmt: StemFormat): number {
  return loopSamples(song, fmt.sampleRate) * fmt.channels * 4 * stems;
}
