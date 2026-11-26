import ding from '../../assets/sounds/ding.wav?url';
import chime from '../../assets/sounds/chime.wav?url';
import bell from '../../assets/sounds/bell.wav?url';
import marimba from '../../assets/sounds/marimba.wav?url';
import pop from '../../assets/sounds/pop.wav?url';
import crystal from '../../assets/sounds/crystal.wav?url';
import { log } from '../platform/log';

/**
 * Agent-done sounds (src/assets/sounds/*.wav, made by .devtools/gen_sounds.py): one is played when an agent CLI
 * finishes its turn (lib/terminal/agentStatus), so the user notices it in another tab, window or application.
 * Which one: TerminalPrefs.agentSoundName (Settings → AGENT DONE SOUND, with a PLAY button to listen).
 * Each file is fetched the first time it is played (Vite gives every one its own hashed asset).
 *
 * Web Audio, not an `<audio>` element: the file is fetched and its 16-bit PCM samples are copied into an
 * AudioBuffer directly, so no media pipeline / decoder is involved (WebKitGTK plays `<audio>` through a GStreamer
 * pipeline that loads the URL itself — not reliable with the desktop app's custom `tauri://` scheme). Anything
 * that is not plain PCM WAV falls back to `decodeAudioData`.
 *
 * Several agents finishing at the same moment ring once (`QUIET_MS`). A browser that does not allow sound yet
 * (no click / key press on the page so far) stays silent; nothing is shown.
 */
export const SOUNDS = [
  { id: 'ding', label: 'Ding', url: ding },
  { id: 'chime', label: 'Chime', url: chime },
  { id: 'bell', label: 'Bell', url: bell },
  { id: 'marimba', label: 'Marimba', url: marimba },
  { id: 'pop', label: 'Pop', url: pop },
  { id: 'crystal', label: 'Crystal', url: crystal },
] as const;
export type SoundId = (typeof SOUNDS)[number]['id'];
export const DEFAULT_SOUND: SoundId = 'ding';
export const isSoundId = (value: unknown): value is SoundId => SOUNDS.some(sound => sound.id === value);

const QUIET_MS = 1500;

let context: AudioContext | null = null;
const buffers = new Map<SoundId, Promise<AudioBuffer | null>>();
let lastPlayed = 0;
/** The sound being previewed (Settings → PLAY): a new preview stops it. */
let previewing: AudioBufferSourceNode | null = null;
let previewCount = 0;

/** A plain PCM WAV (8 / 16-bit, any rate and channel count) → AudioBuffer; null for anything else. */
function parseWav(ctx: AudioContext, data: ArrayBuffer): AudioBuffer | null {
  const view = new DataView(data);
  const tag = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (data.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  for (let at = 12; at + 8 <= data.byteLength;) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      if (format !== 1 || !channels || !rate || (bits !== 16 && bits !== 8)) return null;
      const bytes = bits / 8;
      const frames = Math.floor(Math.min(size, data.byteLength - body) / (bytes * channels));
      const audio = ctx.createBuffer(channels, frames, rate);
      for (let channel = 0; channel < channels; channel++) {
        const out = audio.getChannelData(channel);
        for (let frame = 0; frame < frames; frame++) {
          const at2 = body + (frame * channels + channel) * bytes;
          out[frame] = bits === 16 ? view.getInt16(at2, true) / 32768 : (view.getUint8(at2) - 128) / 128;
        }
      }
      return audio;
    }
    at = body + size + (size & 1);
  }
  return null;
}

async function load(ctx: AudioContext, id: SoundId): Promise<AudioBuffer | null> {
  try {
    const url = SOUNDS.find(sound => sound.id === id)?.url ?? ding;
    const data = await (await fetch(url)).arrayBuffer();
    return parseWav(ctx, data) ?? (await ctx.decodeAudioData(data));
  } catch (error) {
    log.warn('Cannot load the notification sound', error, { quiet: true });
    return null;
  }
}

function audioContext() {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  try {
    context ??= new Context();
  } catch {
    return null;
  }
  return context;
}

/** Plays a sound; the source node once it started (null: no audio, not loaded or not allowed yet). */
async function play(id: SoundId): Promise<AudioBufferSourceNode | null> {
  const ctx = audioContext();
  if (!ctx) return null;
  let buffer = buffers.get(id);
  if (!buffer) {
    buffer = load(ctx, id);
    buffers.set(id, buffer);
  }
  const audio = await buffer;
  if (!audio) return null;
  if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
  if (ctx.state !== 'running') return null; // the browser does not allow sound yet
  const source = ctx.createBufferSource();
  source.buffer = audio;
  source.connect(ctx.destination);
  source.start();
  return source;
}

/** An agent finished its turn: plays the chosen sound (at most once per QUIET_MS). */
export function playAgentSound(id: SoundId) {
  const now = Date.now();
  if (now - lastPlayed < QUIET_MS) return;
  lastPlayed = now;
  void play(id);
}

/** Settings → PLAY: plays a sound now, stopping the one previewed before. */
export function previewSound(id: SoundId) {
  previewing?.stop();
  previewing = null;
  const count = ++previewCount;
  void play(id).then(source => {
    if (count === previewCount) previewing = source;
    else source?.stop(); // clicked again while this one was loading
  });
}
