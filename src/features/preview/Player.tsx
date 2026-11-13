import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { Playing, SongInfo, Thumb } from "../../api";
import { saved, stored } from "../filelist/prefs";
import { ToolCog } from "../../ui/Controls";
import { instrumentName } from "./instruments";
import { channelColor, MidiStage } from "./MidiStage";
import {
  audio,
  letGo,
  now,
  playing,
  playOn,
  queue,
  setMini,
  setNow,
  setQueue,
  setSleep,
  setVolume,
  sleep,
  SLEEPS,
  start,
  stop,
  titleOf,
  volume,
  type Source,
  type Track,
} from "./nowPlaying";
import { lineAt, lyricsOf, type Line } from "./timedText";
import {
  falling,
  lyricsShown,
  playNext,
  setFalling,
  setLyricsShown,
  setPlayNext,
  setSoundSet,
  soundSet,
  VIEWER_SETTINGS,
} from "./viewerPrefs";

export type { Source } from "./nowPlaying";

const ICON_PLAY = "";
const ICON_PAUSE = "";
const ICON_SONG = "";
const ICON_LOOP = "";
const ICON_NEXT = "";
const ICON_CLEAR = "";
const ICON_QUEUE = "";
const ICON_LYRICS = "";
const ICON_SLEEP = "";
const ICON_FALL = "";
const ICON_ACROSS = "";
const ICON_SOUND = "";
const SPEEDS = [1, 1.25, 1.5, 2, 0.5, 0.75];
const STEP_SECONDS = 5;
const BIG_STEP_SECONDS = 30;
/** Longer files remember where they were left, like podcasts and audiobooks. */
const RESUME_FROM_SECONDS = 10 * 60;
const RESUME_MARGIN_SECONDS = 30;
const MOST_RESUMES = 100;
const RESUME_SAVE_MS = 5000;
const RESUME_SHOWN_MS = 15000;
/** Bigger files have their waveform read by the app, as decoding here needs the whole file at once. */
const WAVEFORM_BYTES = 48 * 1024 * 1024;
const WAVEFORM_BARS = 400;
/** A drag shorter than this is a click that seeks. */
const DRAG_PX = 4;
const SHORTEST_SECTION_SECONDS = 0.5;
const COVER_EDGE = 480;
const SHOWN_INSTRUMENTS = 8;
/** A MIDI file is played again this long after the last change to how it plays. */
const RENDER_MS = 350;
const TEMPO_STEP = 0.1;
const SLOWEST = 0.5;
const FASTEST = 2;
const MOST_TRANSPOSE = 12;
const DRUM_CHANNEL = 9;
const SLEEP_NAMES: Record<string, string> = { 0: "Sleep timer", 15: "Stop in 15 minutes", 30: "Stop in 30 minutes", 60: "Stop in an hour", end: "Stop when this song ends" };
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const [speed, setSpeed] = createSignal(1);
const [queueOpen, setQueueOpen] = stored("song-queue", saved("song-queue") === true);

export interface PlayerProps {
  /** The file's full path, which long files remember their place by. */
  path: string;
  name: string;
  size: number;
  load: () => Promise<Source>;
  /** A MIDI file's notes, drawn as a piano roll. */
  info?: () => Promise<SongInfo>;
  /** A MIDI file played with these settings, through this sound set or the bundled one. */
  render?: (playing: Playing, font?: string) => Promise<Source>;
  cover?: (edge: number) => Promise<Thumb | null>;
  /** A waveform's bars, read by the app a little at a time, for sounds too big to decode here at once. */
  peaks?: (bars: number) => Promise<number[]>;
  /** The `.lrc` file beside the song, if there is one. */
  lyrics?: () => Promise<string | null>;
  /** The files of the folder that play, and the sound sets (`.sf2`) there. */
  queue?: () => Promise<{ tracks: Track[]; fonts: string[] }>;
  /** Steps the preview to another row of the list. */
  onPick?: (index: number) => void;
  /** Hands the player's keys to the preview, which passes key presses on first. */
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
  /** A soft color behind the player, taken from the cover. */
  tint: (color: string | undefined) => void;
  /** The song ended with Play next on, or the media keys asked for the next one. */
  onNext: () => void;
}

export const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const rest = `${Math.floor((whole % 3600) / 60)}:${String(whole % 60).padStart(2, "0")}`;
  return hours ? `${hours}:${rest.padStart(5, "0")}` : rest;
};

export function resumes(): Record<string, number> {
  return (saved("song-resume") as Record<string, number> | null) ?? {};
}

export function remember(path: string, seconds: number | undefined) {
  const all = resumes();
  delete all[path];
  if (seconds !== undefined) all[path] = seconds;
  const kept = Object.entries(all).slice(-MOST_RESUMES);
  localStorage.setItem("perli-song-resume", JSON.stringify(Object.fromEntries(kept)));
}

/** The loudest point of each slice of the sound, from 0 to 1. */
async function waveform(url: string): Promise<Float32Array> {
  const bytes = await fetch(url).then((answer) => answer.arrayBuffer());
  const sound = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes);
  const bars = new Float32Array(WAVEFORM_BARS);
  const per = Math.max(1, Math.floor(sound.length / WAVEFORM_BARS));
  for (let channel = 0; channel < sound.numberOfChannels; channel++) {
    const samples = sound.getChannelData(channel);
    for (let bar = 0; bar < WAVEFORM_BARS; bar++) {
      let loudest = bars[bar];
      const end = Math.min(samples.length, (bar + 1) * per);
      for (let at = bar * per; at < end; at++) loudest = Math.max(loudest, Math.abs(samples[at]));
      bars[bar] = loudest;
    }
  }
  const top = Math.max(...bars, 0.01);
  return bars.map((bar) => bar / top);
}

/** The average color of a picture, for the tint behind the player and the glow round the cover. */
function averageColor(picture: Thumb, alpha: number) {
  let [r, g, b, count] = [0, 0, 0, 0];
  const pixels = picture.pixels;
  for (let at = 0; at < pixels.length; at += 16) {
    if (pixels[at + 3] < 128) continue;
    r += pixels[at];
    g += pixels[at + 1];
    b += pixels[at + 2];
    count++;
  }
  return count ? `rgb(${Math.round(r / count)} ${Math.round(g / count)} ${Math.round(b / count)} / ${alpha}%)` : undefined;
}

/**
 * Click on the lane seeks there, and a drag across it loops that part. Shared by the player
 * and the film viewer.
 */
export function laneDrag(
  lane: HTMLElement,
  event: PointerEvent,
  secondsAt: (event: PointerEvent) => number,
  section: () => [number, number] | undefined,
  setSection: (part: [number, number] | undefined) => void,
  seek: (seconds: number) => void,
) {
  const startX = event.clientX;
  const begin = secondsAt(event);
  let dragging = false;
  try {
    lane.setPointerCapture(event.pointerId);
  } catch {
    // A pointer that isn't down any more can't be held.
  }
  const move = (next: PointerEvent) => {
    dragging ||= Math.abs(next.clientX - startX) > DRAG_PX;
    if (dragging) {
      const end = secondsAt(next);
      setSection([Math.min(begin, end), Math.max(begin, end)]);
    }
  };
  const up = (next: PointerEvent) => {
    lane.removeEventListener("pointermove", move);
    lane.removeEventListener("pointerup", up);
    const part = section();
    if (!dragging) seek(secondsAt(next));
    else if (part && part[1] - part[0] >= SHORTEST_SECTION_SECONDS) seek(part[0]);
    else setSection(undefined);
  };
  lane.addEventListener("pointermove", move);
  lane.addEventListener("pointerup", up);
}

/**
 * A player for MIDI and sound files. The lane under the title is the waveform, or the piano roll
 * for MIDI: click it to seek, or drag across it to loop that part. The sound itself belongs to the
 * app, so a song goes on playing once the preview closes, as the disc on the sidebar.
 */
export function Player(live: PlayerProps) {
  // The preview's props follow the row it shows. This player stays with the file it opened on.
  const props = { ...live };
  const midi = !!props.info;
  /** The song is already playing, from the disc or from this same file a moment ago. */
  const kept = now()?.path === props.path ? now() : undefined;
  const [source, setSource] = createSignal<Source | undefined>(kept?.source);
  const [problem, setProblem] = createSignal<string>();
  const [time, setTime] = createSignal(0);
  const [length, setLength] = createSignal(0);
  const [loop, setLoop] = createSignal(false);
  const [section, setSection] = createSignal<[number, number]>();
  const [bars, setBars] = createSignal<Float32Array>();
  const [song, setSong] = createSignal<SongInfo>();
  const [resumeAt, setResumeAt] = createSignal<number>();
  const [hover, setHover] = createSignal<number>();
  const [lyrics, setLyrics] = createSignal<Line[]>([]);
  const [tracks, setTracks] = createSignal<Track[]>([]);
  const [fonts, setFonts] = createSignal<string[]>([]);
  const [settings, setSettings] = createSignal<Playing>(kept?.playing ?? { muted: 0, transpose: 0, speed: 1 });
  const [rendering, setRendering] = createSignal(false);
  let root!: HTMLDivElement;
  let lane!: HTMLDivElement;
  let base!: HTMLCanvasElement;
  let played!: HTMLCanvasElement;
  let lyricBox: HTMLOListElement | undefined;
  let art: HTMLCanvasElement | undefined;
  let gone = false;
  let frame = 0;
  let lastSave = 0;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  /** Counts renders asked for, so only the newest one's sound is kept. */
  let renderAsk = 0;
  /** Where a song played again at another tempo picks up, in its new seconds. */
  let pendingSeek: number | undefined;
  /** The cover, until the song it belongs to has started. */
  let coverUrl: string | undefined;

  const mine = () => now()?.path === props.path;

  /** Hands the cover to the song playing, which shows it on the disc and lets go of it. */
  function giveCover() {
    const song = now();
    if (!coverUrl || !song || song.path !== props.path) return;
    if (song.cover) URL.revokeObjectURL(coverUrl);
    else setNow({ ...song, cover: coverUrl });
    coverUrl = undefined;
    mediaSession();
  }

  async function begin(font = soundSet() ?? undefined) {
    try {
      const loaded = midi && props.render ? await props.render(settings(), font) : await props.load();
      if (gone) return letGo(loaded);
      start({ path: props.path, name: props.name, title: titleOf(props.name, loaded.tags), source: loaded, playing: midi ? settings() : undefined });
      setSource(loaded);
      giveCover();
    } catch (reason) {
      if (gone) return;
      // A sound set that has gone falls back to the bundled one.
      if (font) {
        setSoundSet(null);
        return begin(undefined);
      }
      setProblem(String(reason));
    }
  }

  if (kept) setMini(false);
  else void begin();

  createEffect(() => {
    const loaded = source();
    if (!loaded || midi) return;
    const big = props.size > WAVEFORM_BYTES;
    if (big && !props.peaks) return;
    (big ? props.peaks!(WAVEFORM_BARS).then((found) => Float32Array.from(found)) : waveform(loaded.url))
      .then((found) => gone || setBars(found))
      .catch(() => {});
  });
  props
    .info?.()
    .then((found) => gone || setSong(found))
    .catch(() => {});
  props
    .lyrics?.()
    .then((text) => gone || !text || setLyrics(lyricsOf(text)))
    .catch(() => {});
  props
    .queue?.()
    .then((found) => {
      if (gone) return;
      setTracks(found.tracks);
      setFonts(found.fonts);
    })
    .catch(() => {});
  // The queue goes with the song, so the disc can play on through the folder.
  createEffect(() => source() && mine() && tracks().length && setQueue(tracks()));
  props.tint(midi ? "color-mix(in srgb, var(--accent) 22%, transparent)" : undefined);
  props
    .cover?.(Math.ceil(COVER_EDGE * devicePixelRatio))
    .then((picture) => {
      if (gone || !picture || !art) return;
      art.width = picture.width;
      art.height = picture.height;
      art.getContext("2d")!.putImageData(new ImageData(picture.pixels, picture.width, picture.height), 0, 0);
      art.dataset.shown = "";
      props.tint(averageColor(picture, 30));
      root.style.setProperty("--player-glow", averageColor(picture, 70) ?? "var(--accent)");
      if (now()?.path === props.path && now()?.cover) return;
      art.toBlob((blob) => {
        if (!blob || gone) return;
        coverUrl = URL.createObjectURL(blob);
        giveCover();
      });
    })
    .catch(() => {});

  const title = () => {
    const tags = source()?.tags;
    return tags?.title || song()?.title || props.name.replace(/\.[^.]+$/, "");
  };
  const subtitle = () => {
    const tags = source()?.tags;
    return [tags?.artist, tags?.album].filter(Boolean).join("  ·  ");
  };
  const instruments = () => {
    const all = (song()?.instruments ?? []).map(instrumentName);
    const more = all.length - SHOWN_INSTRUMENTS;
    return more > 1 ? [...all.slice(0, SHOWN_INSTRUMENTS), `${more} more`] : all;
  };
  /** Song seconds for audio seconds: a MIDI file played faster has fewer of them. */
  const tempo = () => (midi ? settings().speed : 1);
  const line = createMemo(() => lineAt(lyrics(), time()));
  const upNext = () => {
    const list = queue();
    const at = list.findIndex((track) => track.path === props.path);
    return playNext() && at >= 0 ? list[at + 1] : undefined;
  };

  function seek(seconds: number) {
    if (!length()) return;
    audio.currentTime = Math.min(Math.max(seconds, 0), length());
    setResumeAt(undefined);
    tick();
  }

  const toggle = () => (audio.paused ? void audio.play().catch(() => {}) : audio.pause());

  /** Moves the playhead and the played part, keeps a looped section looping, and saves the place. */
  function tick() {
    if (!mine()) return;
    const at = audio.currentTime;
    const part = section();
    if (part && !audio.paused && at >= part[1]) audio.currentTime = part[0];
    setTime(audio.currentTime);
    const share = length() ? audio.currentTime / length() : 0;
    lane?.style.setProperty("--at", String(share));
    // The cover's glow breathes with how loud the song is where it plays.
    const found = bars();
    if (found) root.style.setProperty("--level", String(found[Math.min(found.length - 1, Math.floor(share * found.length))] ?? 0));
    // The start of a file never takes the place of one saved further in.
    if (length() > RESUME_FROM_SECONDS && at > RESUME_MARGIN_SECONDS && Date.now() - lastSave > RESUME_SAVE_MS) {
      lastSave = Date.now();
      remember(props.path, at);
    }
  }

  function run() {
    cancelAnimationFrame(frame);
    tick();
    if (!audio.paused && !gone) frame = requestAnimationFrame(run);
  }

  function onMetadata() {
    if (!mine()) return;
    setLength(audio.duration);
    audio.playbackRate = midi ? 1 : speed();
    if (pendingSeek !== undefined) {
      audio.currentTime = Math.min(pendingSeek, audio.duration);
      pendingSeek = undefined;
    } else if (!kept) {
      const at = resumes()[props.path];
      if (audio.duration > RESUME_FROM_SECONDS && at > RESUME_MARGIN_SECONDS && at < audio.duration - RESUME_MARGIN_SECONDS) {
        setResumeAt(at);
        resumeTimer = setTimeout(() => setResumeAt(undefined), RESUME_SHOWN_MS);
      }
    }
    mediaSession();
    drawLane();
  }

  function onEnded() {
    if (!mine()) return;
    if (length() > RESUME_FROM_SECONDS) remember(props.path, undefined);
    if (sleep() === "end") return setSleep(0);
    if (playNext() && !loop()) props.onNext();
  }

  const listen = (type: keyof HTMLMediaElementEventMap, handler: () => void) => {
    audio.addEventListener(type, handler);
    onCleanup(() => audio.removeEventListener(type, handler));
  };
  listen("play", run);
  listen("pause", tick);
  listen("loadedmetadata", onMetadata);
  listen("seeked", tick);
  listen("ended", onEnded);
  if (kept && audio.readyState >= 1) queueMicrotask(onMetadata);
  if (kept && !audio.paused) queueMicrotask(run);

  function mediaSession() {
    if (!("mediaSession" in navigator) || gone || !mine()) return;
    const tags = source()?.tags;
    const cover = now()?.cover;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title(),
      artist: tags?.artist ?? "",
      album: tags?.album ?? "",
      artwork: cover ? [{ src: cover }] : [],
    });
    const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => void audio.play()],
      ["pause", () => audio.pause()],
      ["seekbackward", () => seek(audio.currentTime - STEP_SECONDS)],
      ["seekforward", () => seek(audio.currentTime + STEP_SECONDS)],
      ["seekto", (details) => seek(details.seekTime ?? 0)],
      ["nexttrack", () => props.onNext()],
    ];
    for (const [action, handler] of actions) navigator.mediaSession.setActionHandler(action, handler);
  }

  /** Plays the MIDI file again the new way, from the same point of the song. */
  function replay(next: Playing, font = soundSet() ?? undefined) {
    setSettings(next);
    setSection(undefined);
    clearTimeout(renderTimer);
    const ask = ++renderAsk;
    renderTimer = setTimeout(async () => {
      setRendering(true);
      try {
        const loaded = await props.render!(next, font);
        // A render asked for later wins, even if this one, started first, ends last.
        if (gone || !mine() || ask !== renderAsk) return letGo(loaded);
        const songTime = audio.currentTime * (now()?.playing?.speed ?? 1);
        pendingSeek = songTime / next.speed;
        start({ ...now()!, source: loaded, playing: next }, !audio.paused);
        setSource(loaded);
      } catch (reason) {
        if (gone || ask !== renderAsk) return;
        if (font) setSoundSet(null);
        setProblem(String(reason));
      } finally {
        if (!gone && ask === renderAsk) setRendering(false);
      }
    }, RENDER_MS);
  }

  const changeTempo = (by: number) =>
    replay({ ...settings(), speed: Math.round(Math.min(Math.max(settings().speed + by, SLOWEST), FASTEST) * 10) / 10 });
  const changeKey = (by: number) =>
    replay({ ...settings(), transpose: Math.min(Math.max(settings().transpose + by, -MOST_TRANSPOSE), MOST_TRANSPOSE) });
  const silent = (channel: number) => (settings().muted & (1 << channel)) !== 0;

  /** A click mutes the channel or lets it play again. Shift plays it alone, or everything again. */
  function onChannel(event: MouseEvent, channel: number) {
    const all = (song()?.channels ?? []).reduce((bits, [one]) => bits | (1 << one), 0);
    const alone = all & ~(1 << channel);
    const muted = event.shiftKey ? (settings().muted === alone ? 0 : alone) : settings().muted ^ (1 << channel);
    replay({ ...settings(), muted });
  }

  /** The bundled sound set, then each `.sf2` of this folder, then the one chosen before. */
  const soundSets = () => [null, ...new Set([...fonts(), ...(soundSet() ? [soundSet()!] : [])])];
  const soundName = (font: string | null) => (font ? font.split(/[\\/]/).pop()!.replace(/\.sf2$/i, "") : "Built-in sounds");
  function nextSoundSet() {
    const all = soundSets();
    const next = all[(all.indexOf(soundSet()) + 1) % all.length];
    setSoundSet(next);
    replay(settings(), next ?? undefined);
  }

  const nextSleep = () => setSleep(SLEEPS[(SLEEPS.indexOf(sleep()) + 1) % SLEEPS.length]);

  props.keys((event) => {
    if (event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement && event.target.type !== "range") return false;
    const step = event.shiftKey ? BIG_STEP_SECONDS : STEP_SECONDS;
    const key = event.key;
    if (key === "ArrowLeft") seek(audio.currentTime - step);
    else if (key === "ArrowRight") seek(audio.currentTime + step);
    else if (key === "p" || key === "P" || key === "k") toggle();
    else if (key === "l" || key === "L") setLoop(!loop());
    else if (key === "q" || key === "Q") setQueueOpen(!queueOpen());
    else if ((key === "y" || key === "Y") && lyrics().length) setLyricsShown(!lyricsShown());
    else if (/^[0-9]$/.test(key)) seek((length() * Number(key)) / 10);
    else if (midi && (key === "v" || key === "V")) setFalling(!falling());
    else if (midi && key === "[") changeTempo(-TEMPO_STEP);
    else if (midi && key === "]") changeTempo(TEMPO_STEP);
    else if (midi && key === "-") changeKey(-1);
    else if (midi && (key === "=" || key === "+")) changeKey(1);
    else return false;
    return true;
  });

  onCleanup(() => {
    gone = true;
    cancelAnimationFrame(frame);
    clearTimeout(resumeTimer);
    clearTimeout(renderTimer);
    props.keys(undefined);
    props.tint(undefined);
    if (coverUrl) URL.revokeObjectURL(coverUrl);
    if (!mine()) return;
    if (length() > RESUME_FROM_SECONDS && audio.currentTime > RESUME_MARGIN_SECONDS) remember(props.path, audio.currentTime);
    // A song still playing goes on as the disc. One paused is put away.
    if (audio.paused) stop();
    else playOn();
  });

  createEffect(() => (audio.volume = volume()));
  createEffect(() => mine() && (audio.loop = loop()));
  createEffect(() => mine() && (audio.playbackRate = midi ? 1 : speed()));
  createEffect(() => {
    bars();
    song();
    settings();
    drawLane();
  });
  // The line being sung stays in the middle of the lyrics.
  createEffect(() => {
    const at = line();
    const item = lyricBox?.children[at] as HTMLElement | undefined;
    if (!lyricBox || !item) return;
    lyricBox.scrollTo({
      top: item.offsetTop - lyricBox.clientHeight / 2 + item.offsetHeight / 2,
      behavior: reducedMotion.matches ? "auto" : "smooth",
    });
  });

  /** Draws the lane twice: plainly, and in the accent color for the part already played. */
  function drawLane() {
    if (!base || !played) return;
    const box = lane.getBoundingClientRect();
    const scale = devicePixelRatio;
    const style = getComputedStyle(lane);
    for (const [canvas, color] of [
      [base, style.getPropertyValue("--lane-ahead")],
      [played, style.getPropertyValue("--lane-played")],
    ] as const) {
      canvas.width = Math.max(1, Math.round(box.width * scale));
      canvas.height = Math.max(1, Math.round(box.height * scale));
      const pen = canvas.getContext("2d")!;
      pen.fillStyle = color;
      paint(pen, canvas.width, canvas.height, scale);
    }
  }

  function paint(pen: CanvasRenderingContext2D, width: number, height: number, scale: number) {
    const notes = song()?.notes;
    if (notes?.start.length && length()) {
      let [low, high] = [127, 0];
      for (const key of notes.key) [low, high] = [Math.min(low, key), Math.max(high, key)];
      const rows = high - low + 1;
      const tall = Math.max(scale, Math.min(height / rows, 4 * scale));
      const seconds = length() * tempo();
      for (let at = 0; at < notes.start.length; at++) {
        if (silent(notes.channel[at])) continue;
        const x = (notes.start[at] / seconds) * width;
        const y = height - ((notes.key[at] - low + 1) / rows) * (height - tall) - tall / 2;
        pen.fillRect(x, y, Math.max(scale, (notes.long[at] / seconds) * width), tall);
      }
      return;
    }
    const found = bars();
    if (!found) {
      pen.fillRect(0, height / 2 - scale, width, 2 * scale);
      return;
    }
    const slot = width / found.length;
    for (let bar = 0; bar < found.length; bar++) {
      const tall = Math.max(2 * scale, found[bar] * height);
      pen.fillRect(bar * slot, (height - tall) / 2, Math.max(scale, slot - scale), tall);
    }
  }

  const secondsAt = (event: PointerEvent) => {
    const box = lane.getBoundingClientRect();
    return (Math.min(Math.max(event.clientX - box.left, 0), box.width) / box.width) * length();
  };

  function onLaneDown(event: PointerEvent) {
    if (event.button !== 0 || !length()) return;
    laneDrag(lane, event, secondsAt, section, setSection, seek);
  }

  const percent = (seconds: number) => `${length() ? (seconds / length()) * 100 : 0}%`;
  const channelName = (channel: number, instrument: number) => (channel === DRUM_CHANNEL ? "Drums" : instrumentName(instrument));

  return (
    <div
      ref={root}
      class="player"
      data-midi={midi || undefined}
      data-playing={playing() || undefined}
      data-lyrics={(lyricsShown() && lyrics().length > 0) || undefined}
    >
      <Show
        when={midi && song()?.notes.start.length}
        fallback={
          <div class="player-art">
            <span class="song-icon" aria-hidden="true">
              {ICON_SONG}
            </span>
            <Show when={props.cover}>
              <canvas ref={art} class="player-cover" aria-hidden="true" />
            </Show>
          </div>
        }
      >
        <MidiStage
          notes={song()!.notes}
          beats={song()!.beats}
          bars={song()!.bars}
          muted={settings().muted}
          falling={falling()}
          time={() => time() * tempo()}
          playing={playing()}
        />
      </Show>
      <div class="player-title">{title()}</div>
      <Show when={subtitle()}>
        <div class="player-sub">{subtitle()}</div>
      </Show>
      <Show
        when={midi && song()?.channels.length}
        fallback={
          <Show when={instruments().length}>
            <div class="player-instruments" aria-label="Instruments">
              <For each={instruments()}>{(name) => <span>{name}</span>}</For>
            </div>
          </Show>
        }
      >
        <div class="player-instruments midi-channels" role="group" aria-label="Instruments">
          <For each={song()!.channels}>
            {([channel, instrument]) => (
              <button
                class="midi-channel"
                style={{ "--channel": channelColor(channel) }}
                aria-pressed={!silent(channel)}
                aria-label={`${silent(channel) ? "Play" : "Mute"} ${channelName(channel, instrument)}. Shift plays it alone`}
                onClick={(event) => onChannel(event, channel)}
              >
                {channelName(channel, instrument)}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={lyricsShown() && lyrics().length}>
        <ol ref={lyricBox} class="player-lyrics" aria-label="Lyrics">
          <For each={lyrics()}>
            {(words, at) => (
              <li aria-current={at() === line() ? "true" : undefined} onClick={() => seek(words.at)}>
                {words.text || "♪"}
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show
        when={source()}
        fallback={
          <Show when={problem()} fallback={<div class="player-loading" role="progressbar" aria-label="Getting the song ready" />}>
            <p class="preview-note" role="alert">
              {problem()}
            </p>
          </Show>
        }
      >
        <div
          ref={(element) => {
            lane = element;
            const watcher = new ResizeObserver(() => drawLane());
            watcher.observe(element);
            onCleanup(() => watcher.disconnect());
          }}
          class="player-lane"
          data-busy={rendering() || undefined}
          role="slider"
          aria-label="Position"
          aria-valuemin="0"
          aria-valuemax={Math.round(length())}
          aria-valuenow={Math.round(time())}
          aria-valuetext={`${clock(time())} of ${clock(length())}`}
          onPointerDown={onLaneDown}
          onPointerMove={(event) => setHover(secondsAt(event))}
          onPointerLeave={() => setHover(undefined)}
        >
          <canvas ref={base} class="lane-ahead" />
          <canvas ref={played} class="lane-played" />
          <Show when={section()}>
            {(part) => <div class="lane-section" style={{ left: percent(part()[0]), width: percent(part()[1] - part()[0]) }} />}
          </Show>
          <div class="lane-head" />
          <Show when={hover() !== undefined}>
            <div class="lane-tip" style={{ left: percent(hover()!) }}>
              {clock(hover()!)}
            </div>
          </Show>
        </div>
        <div class="song-bar">
          <button
            class="strip-icon song-play"
            aria-label={playing() ? "Pause" : "Play"}
            aria-keyshortcuts="P"
            onClick={toggle}
          >
            {playing() ? ICON_PAUSE : ICON_PLAY}
          </button>
          <span class="song-time">
            {clock(time())} / {clock(length())}
          </span>
          <Show when={resumeAt()}>
            {(at) => (
              <button class="player-resume" onClick={() => seek(at())}>
                Resume at {clock(at())}
              </button>
            )}
          </Show>
          <span class="song-gap" />
          <Show when={section()}>
            <button class="strip-icon" aria-label="Stop looping this part" onClick={() => setSection(undefined)}>
              {ICON_CLEAR}
            </button>
          </Show>
          <Show
            when={midi}
            fallback={
              <button
                class="strip-icon song-speed"
                aria-label="Speed"
                onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed()) + 1) % SPEEDS.length])}
              >
                {speed()}×
              </button>
            }
          >
            <span class="midi-step" role="group" aria-label="Tempo">
              <button class="strip-icon" aria-label="Slower" aria-keyshortcuts="[" disabled={settings().speed <= SLOWEST} onClick={() => changeTempo(-TEMPO_STEP)}>
                −
              </button>
              <span class="midi-value">{Math.round(settings().speed * 100)}%</span>
              <button class="strip-icon" aria-label="Faster" aria-keyshortcuts="]" disabled={settings().speed >= FASTEST} onClick={() => changeTempo(TEMPO_STEP)}>
                +
              </button>
            </span>
            <span class="midi-step" role="group" aria-label="Key">
              <button class="strip-icon" aria-label="Lower key" aria-keyshortcuts="-" disabled={settings().transpose <= -MOST_TRANSPOSE} onClick={() => changeKey(-1)}>
                ♭
              </button>
              <span class="midi-value">{settings().transpose > 0 ? `+${settings().transpose}` : settings().transpose}</span>
              <button class="strip-icon" aria-label="Higher key" aria-keyshortcuts="=" disabled={settings().transpose >= MOST_TRANSPOSE} onClick={() => changeKey(1)}>
                ♯
              </button>
            </span>
            <button
              class="strip-icon"
              aria-label={falling() ? "Notes run past the keyboard" : "Notes fall onto the keyboard"}
              aria-keyshortcuts="V"
              onClick={() => setFalling(!falling())}
            >
              {falling() ? ICON_ACROSS : ICON_FALL}
            </button>
            <button class="strip-icon" aria-label={`Sound set: ${soundName(soundSet())}`} disabled={soundSets().length < 2} onClick={nextSoundSet}>
              {ICON_SOUND}
            </button>
          </Show>
          <button
            class="strip-icon"
            aria-label="Loop"
            aria-keyshortcuts="L"
            aria-pressed={loop()}
            onClick={() => setLoop(!loop())}
          >
            {ICON_LOOP}
          </button>
          <button class="strip-icon" aria-label="Play next" aria-pressed={playNext()} onClick={() => setPlayNext(!playNext())}>
            {ICON_NEXT}
          </button>
          <Show when={lyrics().length}>
            <button class="strip-icon" aria-label="Lyrics" aria-keyshortcuts="Y" aria-pressed={lyricsShown()} onClick={() => setLyricsShown(!lyricsShown())}>
              {ICON_LYRICS}
            </button>
          </Show>
          <Show when={tracks().length > 1}>
            <button class="strip-icon" aria-label="Songs in this folder" aria-keyshortcuts="Q" aria-pressed={queueOpen()} onClick={() => setQueueOpen(!queueOpen())}>
              {ICON_QUEUE}
            </button>
          </Show>
          <button class="strip-icon song-sleep" aria-label={SLEEP_NAMES[String(sleep())]} aria-pressed={sleep() !== 0} onClick={nextSleep}>
            {ICON_SLEEP}
            <Show when={sleep()}>
              <span class="song-sleep-badge">{sleep() === "end" ? "♪" : sleep()}</span>
            </Show>
          </button>
          <input
            class="song-volume"
            type="range"
            aria-label="Volume"
            min="0"
            max="1"
            step="0.05"
            value={volume()}
            style={{ "--fill": volume() }}
            onInput={(event) => setVolume(event.currentTarget.valueAsNumber)}
          />
          <ToolCog label="Music settings" items={VIEWER_SETTINGS.Music} />
        </div>
        <Show when={upNext()}>
          {(next) => <p class="song-next">Up next: {titleOf(next().name)}</p>}
        </Show>
      </Show>
      <Show when={queueOpen() && tracks().length > 1}>
        <ol class="song-queue" aria-label="Songs in this folder">
          <For each={tracks()}>
            {(track) => (
              <li>
                <button aria-current={track.path === props.path ? "true" : undefined} onClick={() => track.path !== props.path && props.onPick?.(track.index)}>
                  {titleOf(track.name)}
                </button>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </div>
  );
}
