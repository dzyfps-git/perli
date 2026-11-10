import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { SongInfo, Tags, Thumb } from "../../api";
import { saved, stored } from "../filelist/prefs";
import { instrumentName } from "./instruments";

const ICON_PLAY = "";
const ICON_PAUSE = "";
const ICON_SONG = "";
const ICON_LOOP = "";
const ICON_NEXT = "";
const ICON_CLEAR = "";
const SPEEDS = [1, 1.25, 1.5, 2, 0.5, 0.75];
const STEP_SECONDS = 5;
const BIG_STEP_SECONDS = 30;
/** Longer files remember where they were left, like podcasts and audiobooks. */
const RESUME_FROM_SECONDS = 10 * 60;
const RESUME_MARGIN_SECONDS = 30;
const MOST_RESUMES = 100;
const RESUME_SAVE_MS = 5000;
const RESUME_SHOWN_MS = 15000;
/** Bigger files skip the waveform, which needs the whole file decoded at once. */
const WAVEFORM_BYTES = 48 * 1024 * 1024;
const WAVEFORM_BARS = 400;
/** A drag shorter than this is a click that seeks. */
const DRAG_PX = 4;
const SHORTEST_SECTION_SECONDS = 0.5;
const COVER_EDGE = 320;
const SHOWN_INSTRUMENTS = 8;

const [volume, setVolume] = stored("song-volume", (saved("song-volume") as number | null) ?? 1);
const [playNext, setPlayNext] = stored("song-play-next", saved("song-play-next") === true);
const [speed, setSpeed] = createSignal(1);

/** Where the sound comes from. `made` marks a URL made here, which must be let go of. */
export interface Source {
  url: string;
  made: boolean;
  tags: Tags;
}

export interface PlayerProps {
  /** The file's full path, which long files remember their place by. */
  path: string;
  name: string;
  size: number;
  load: () => Promise<Source>;
  /** A MIDI file's notes, drawn as a piano roll. */
  info?: () => Promise<SongInfo>;
  cover?: (edge: number) => Promise<Thumb | null>;
  /** Hands the player's keys to the preview, which passes key presses on first. */
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
  /** A soft color behind the player, taken from the cover. */
  tint: (color: string | undefined) => void;
  /** The song ended with Play next on, or the media keys asked for the next one. */
  onNext: () => void;
}

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const rest = `${Math.floor((whole % 3600) / 60)}:${String(whole % 60).padStart(2, "0")}`;
  return hours ? `${hours}:${rest.padStart(5, "0")}` : rest;
};

function resumes(): Record<string, number> {
  return (saved("song-resume") as Record<string, number> | null) ?? {};
}

function remember(path: string, seconds: number | undefined) {
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

/** The average color of a picture, for the tint behind the player. */
function averageColor(picture: Thumb) {
  let [r, g, b, count] = [0, 0, 0, 0];
  const pixels = picture.pixels;
  for (let at = 0; at < pixels.length; at += 16) {
    if (pixels[at + 3] < 128) continue;
    r += pixels[at];
    g += pixels[at + 1];
    b += pixels[at + 2];
    count++;
  }
  return count ? `rgb(${Math.round(r / count)} ${Math.round(g / count)} ${Math.round(b / count)} / 30%)` : undefined;
}

/**
 * A player for MIDI and sound files. The lane under the title is the waveform, or the piano roll
 * for MIDI: click it to seek, or drag across it to loop that part. It plays at once and stops
 * when the preview moves on.
 */
export function Player(live: PlayerProps) {
  // The preview's props follow the row it shows. This player stays with the file it opened on.
  const props = { ...live };
  const [source, setSource] = createSignal<Source>();
  const [problem, setProblem] = createSignal<string>();
  const [playing, setPlaying] = createSignal(false);
  const [time, setTime] = createSignal(0);
  const [length, setLength] = createSignal(0);
  const [loop, setLoop] = createSignal(false);
  const [section, setSection] = createSignal<[number, number]>();
  const [bars, setBars] = createSignal<Float32Array>();
  const [song, setSong] = createSignal<SongInfo>();
  const [resumeAt, setResumeAt] = createSignal<number>();
  const [hover, setHover] = createSignal<number>();
  let audio!: HTMLAudioElement;
  let lane!: HTMLDivElement;
  let base!: HTMLCanvasElement;
  let played!: HTMLCanvasElement;
  let art: HTMLCanvasElement | undefined;
  let gone = false;
  let frame = 0;
  let lastSave = 0;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let coverUrl: string | undefined;

  props
    .load()
    .then((loaded) => {
      if (gone) return loaded.made && URL.revokeObjectURL(loaded.url);
      setSource(loaded);
      if (!props.info && props.size <= WAVEFORM_BYTES) {
        waveform(loaded.url)
          .then((found) => gone || setBars(found))
          .catch(() => {});
      }
    })
    .catch((reason) => gone || setProblem(String(reason)));
  props
    .info?.()
    .then((found) => gone || setSong(found))
    .catch(() => {});
  props.tint(props.info ? "color-mix(in srgb, var(--accent) 22%, transparent)" : undefined);
  props
    .cover?.(Math.ceil(COVER_EDGE * devicePixelRatio))
    .then((picture) => {
      if (gone || !picture || !art) return;
      art.width = picture.width;
      art.height = picture.height;
      art.getContext("2d")!.putImageData(new ImageData(picture.pixels, picture.width, picture.height), 0, 0);
      art.dataset.shown = "";
      props.tint(averageColor(picture));
      art.toBlob((blob) => {
        if (!blob || gone) return;
        coverUrl = URL.createObjectURL(blob);
        mediaSession();
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

  function seek(seconds: number) {
    if (!length()) return;
    audio.currentTime = Math.min(Math.max(seconds, 0), length());
    setResumeAt(undefined);
    tick();
  }

  const toggle = () => (audio.paused ? void audio.play().catch(() => {}) : audio.pause());

  /** Moves the playhead and the played part, keeps a looped section looping, and saves the place. */
  function tick() {
    const now = audio.currentTime;
    const part = section();
    if (part && playing() && now >= part[1]) audio.currentTime = part[0];
    setTime(audio.currentTime);
    lane?.style.setProperty("--at", String(length() ? audio.currentTime / length() : 0));
    // The start of a file never takes the place of one saved further in.
    if (length() > RESUME_FROM_SECONDS && now > RESUME_MARGIN_SECONDS && Date.now() - lastSave > RESUME_SAVE_MS) {
      lastSave = Date.now();
      remember(props.path, now);
    }
  }

  function run() {
    tick();
    if (!audio.paused) frame = requestAnimationFrame(run);
  }

  function onMetadata() {
    setLength(audio.duration);
    audio.playbackRate = speed();
    const at = resumes()[props.path];
    if (audio.duration > RESUME_FROM_SECONDS && at > RESUME_MARGIN_SECONDS && at < audio.duration - RESUME_MARGIN_SECONDS) {
      setResumeAt(at);
      resumeTimer = setTimeout(() => setResumeAt(undefined), RESUME_SHOWN_MS);
    }
    mediaSession();
    drawLane();
  }

  function onEnded() {
    if (length() > RESUME_FROM_SECONDS) remember(props.path, undefined);
    if (playNext() && !loop()) props.onNext();
  }

  function mediaSession() {
    if (!("mediaSession" in navigator) || gone) return;
    const tags = source()?.tags;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title(),
      artist: tags?.artist ?? "",
      album: tags?.album ?? "",
      artwork: coverUrl ? [{ src: coverUrl }] : [],
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

  props.keys((event) => {
    const step = event.shiftKey ? BIG_STEP_SECONDS : STEP_SECONDS;
    const key = event.key;
    if (key === "ArrowLeft") seek(audio.currentTime - step);
    else if (key === "ArrowRight") seek(audio.currentTime + step);
    else if (key === "p" || key === "P" || key === "k") toggle();
    else if (key === "l" || key === "L") setLoop(!loop());
    else if (/^[0-9]$/.test(key)) seek((length() * Number(key)) / 10);
    else return false;
    return true;
  });

  onCleanup(() => {
    gone = true;
    cancelAnimationFrame(frame);
    clearTimeout(resumeTimer);
    if (length() > RESUME_FROM_SECONDS && audio.currentTime > RESUME_MARGIN_SECONDS) remember(props.path, audio.currentTime);
    audio.pause();
    props.keys(undefined);
    props.tint(undefined);
    const made = source();
    if (made?.made) URL.revokeObjectURL(made.url);
    if (coverUrl) URL.revokeObjectURL(coverUrl);
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
  });

  createEffect(() => (audio.volume = volume()));
  createEffect(() => (audio.loop = loop()));
  createEffect(() => (audio.playbackRate = speed()));
  createEffect(() => {
    bars();
    song();
    drawLane();
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
    if (notes?.length && length()) {
      const [low, high] = notes.reduce(([lo, hi], note) => [Math.min(lo, note[2]), Math.max(hi, note[2])], [127, 0]);
      const rows = high - low + 1;
      const tall = Math.max(scale, Math.min(height / rows, 4 * scale));
      for (const [start, long, key] of notes) {
        const x = (start / length()) * width;
        const y = height - ((key - low + 1) / rows) * (height - tall) - tall / 2;
        pen.fillRect(x, y, Math.max(scale, (long / length()) * width), tall);
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
    const startX = event.clientX;
    const start = secondsAt(event);
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
        setSection([Math.min(start, end), Math.max(start, end)]);
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

  const percent = (seconds: number) => `${length() ? (seconds / length()) * 100 : 0}%`;

  return (
    <div class="player">
      <div class="player-art">
        <span class="song-icon" aria-hidden="true">
          {ICON_SONG}
        </span>
        <Show when={props.cover}>
          <canvas ref={art} class="player-cover" aria-hidden="true" />
        </Show>
      </div>
      <div class="player-title">{title()}</div>
      <Show when={subtitle()}>
        <div class="player-sub">{subtitle()}</div>
      </Show>
      <Show when={instruments().length}>
        <div class="player-instruments" aria-label="Instruments">
          <For each={instruments()}>{(name) => <span>{name}</span>}</For>
        </div>
      </Show>
      <audio
        ref={audio}
        src={source()?.url}
        autoplay
        onPlay={() => {
          setPlaying(true);
          run();
        }}
        onPause={() => {
          setPlaying(false);
          tick();
        }}
        onLoadedMetadata={onMetadata}
        onSeeked={tick}
        onEnded={onEnded}
      />
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
          <button
            class="strip-icon song-speed"
            aria-label="Speed"
            onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed()) + 1) % SPEEDS.length])}
          >
            {speed()}×
          </button>
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
          <input
            class="song-volume"
            type="range"
            aria-label="Volume"
            min="0"
            max="1"
            step="0.05"
            value={volume()}
            onInput={(event) => setVolume(event.currentTarget.valueAsNumber)}
          />
        </div>
      </Show>
    </div>
  );
}
