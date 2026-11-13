import { convertFileSrc } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { aiffAudio, openAudio, songAudio, type Playing, type Tags } from "../../api";
import { saved, stored } from "../filelist/prefs";
import { playNext } from "./viewerPrefs";

/**
 * The song that is playing. The app has one sound element, kept here and not in the player, so a
 * song can go on after the preview that started it has closed. It then shows as the small disc
 * on the sidebar.
 */

/** Where the sound comes from. `made` marks a URL made here, which must be let go of. */
export interface Source {
  url: string;
  made: boolean;
  tags: Tags;
}

/** A file of the folder that can play, and its row in the list if it is still known. */
export interface Track {
  path: string;
  name: string;
  index: number;
}

export interface Now {
  path: string;
  name: string;
  title: string;
  source: Source;
  /** A URL for the album cover, made here. */
  cover?: string;
  /** How a MIDI file was played, which the player picks up again. */
  playing?: Playing;
}

export const MIDI = /\.midi?$/i;
/** Sound the window cannot play, which Rust hands over as a WAV. */
export const AIFF = /\.(aiff?|aifc)$/i;
const NO_TAGS: Tags = { title: null, artist: null, album: null };
const FADE_MS = 4000;
const FADE_STEPS = 40;

export const audio = new Audio();
export const [volume, setVolume] = stored("song-volume", (saved("song-volume") as number | null) ?? 1);
export const [now, setNow] = createSignal<Now>();
/** The preview has closed and the song goes on. */
export const [mini, setMini] = createSignal(false);
export const [playing, setPlaying] = createSignal(false);
/** The songs of the folder the one playing came from, in list order. */
export const [queue, setQueue] = createSignal<Track[]>([]);

audio.volume = volume();
audio.addEventListener("play", () => setPlaying(true));
audio.addEventListener("pause", () => setPlaying(false));

export const wav = (bytes: ArrayBuffer): Source => ({
  url: URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })),
  made: true,
  tags: NO_TAGS,
});

/** A song by its path alone, for one that plays after its list has moved on. */
export async function sourceOf(path: string): Promise<Source> {
  if (MIDI.test(path)) return wav(await songAudio(0, 0, 0, { path }));
  if (AIFF.test(path)) return wav(await aiffAudio(0, 0, 0, path));
  const [shown, tags] = await openAudio(0, 0, 0, path);
  return { url: convertFileSrc(shown), made: false, tags };
}

export const titleOf = (name: string, tags?: Tags) => tags?.title || name.replace(/\.[^.]+$/, "");

/** Lets go of what the song playing made, before another takes its place. */
export function release() {
  const song = now();
  if (song?.source.made) URL.revokeObjectURL(song.source.url);
  if (song?.cover) URL.revokeObjectURL(song.cover);
}

/** Plays `song` in place of the one before, which is let go of. */
export function start(song: Now, play = true) {
  const before = now();
  if (before?.source.made && before.source.url !== song.source.url) URL.revokeObjectURL(before.source.url);
  if (before?.cover && before.cover !== song.cover) URL.revokeObjectURL(before.cover);
  setNow(song);
  setMini(false);
  audio.src = song.source.url;
  if (play) audio.play().catch(() => {});
}

export function stop() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  release();
  setNow(undefined);
  setMini(false);
  setSleep(0);
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
}

/** Where the song playing is in the queue, and whether one follows it. */
export const queueAt = () => queue().findIndex((track) => track.path === now()?.path);
export const hasNext = () => queueAt() >= 0 && queueAt() + 1 < queue().length;

/** On to the next song of the queue, without a preview. False when there is none. */
let skips = 0;

export async function skip() {
  const next = queue()[queueAt() + 1];
  if (queueAt() < 0 || !next) return false;
  const [mine, from] = [++skips, now()];
  const source = await sourceOf(next.path);
  // A MIDI song takes a while to render. Stop, or a newer skip, in that time wins.
  if (mine !== skips || now() !== from) {
    if (source.made) URL.revokeObjectURL(source.url);
    return true;
  }
  start({ path: next.path, name: next.name, title: titleOf(next.name, source.tags), source });
  setMini(true);
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: now()!.title, artist: source.tags.artist ?? "" });
  return true;
}

/** With no player open, the media keys and the end of a song are answered here. */
export function playOn() {
  setMini(true);
  if ("mediaSession" in navigator) navigator.mediaSession.setActionHandler("nexttrack", () => void skip().catch(stop));
}

audio.addEventListener("ended", () => {
  if (!mini()) return;
  if (sleep() === "end" || !playNext()) return stop();
  skip().then((went) => went || stop(), stop);
});

/** Stop after so many minutes, or when the song ends. */
export type Sleep = 0 | 15 | 30 | 60 | "end";
export const SLEEPS: Sleep[] = [0, 15, 30, 60, "end"];
const [sleepNow, setSleepNow] = createSignal<Sleep>(0);
export const sleep = sleepNow;
let sleepTimer: number | undefined;
let fadeTimer: number | undefined;

export function setSleep(next: Sleep) {
  window.clearTimeout(sleepTimer);
  window.clearInterval(fadeTimer);
  audio.volume = volume();
  setSleepNow(next);
  if (typeof next === "number" && next) sleepTimer = window.setTimeout(fadeOut, next * 60_000);
}

/** The sound sinks away over a few seconds, so sleep is not broken by a cut. */
function fadeOut() {
  let step = FADE_STEPS;
  fadeTimer = window.setInterval(() => {
    step--;
    audio.volume = volume() * Math.max(step, 0) / FADE_STEPS;
    if (step > 0) return;
    audio.pause();
    setSleep(0);
  }, FADE_MS / FADE_STEPS);
}
