import { convertFileSrc } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { besideText, miniFit, miniTake, openAudio } from "../../api";
import { saved, stored } from "../filelist/prefs";
import { clock, remember, resumes } from "../preview/playback";
import { cuesOf, type Cue } from "../preview/timedText";
import { playNext, setSubtitles, subtitles } from "../preview/viewerPrefs";
import { caughtUp, placeOf, upNextShown, type Film, type HandBack, type Handover, type MiniPlace } from "./handover";
import "./mini.css";

const ICON_PLAY = "";
const ICON_PAUSE = "";
const ICON_NEXT = "";
const ICON_LOOP = "";
const ICON_VOLUME = "";
const ICON_MUTED = "";
const ICON_CAPTIONS = "";
const ICON_BACK = "";
const ICON_CLOSE = "";
const SPEEDS = [1, 1.25, 1.5, 2, 0.5, 0.75];
const STEP_SECONDS = 5;
const BIG_STEP_SECONDS = 30;
const VOLUME_STEP = 0.05;
/** Controls rest this long after the pointer stops. */
const IDLE_MS = 2200;
const TOAST_MS = 1100;
/** A press that moves this far is a drag of the window, not a click. */
const DRAG_PIXELS = 4;
const ARRIVE_MS = 520;
const RESUME_FROM_SECONDS = 10 * 60;
const RESUME_MARGIN_SECONDS = 30;

const [volume, setVolume] = stored("song-volume", (saved("song-volume") as number | null) ?? 1);
const [place, setPlace] = stored<MiniPlace>("mini-place", placeOf(saved("mini-place")));

/**
 * The film that plays on after its preview has closed, in a small window over every other. Its
 * controls rest until the pointer comes, it fades back when the pointer leaves, Windows moves it
 * and it springs to a corner, and it can hand the film back to the full player at the same moment.
 */
export function MiniVideo() {
  const [film, setFilm] = createSignal<Handover>();
  const [playing, setPlaying] = createSignal(false);
  const [ended, setEnded] = createSignal(false);
  const [time, setTime] = createSignal(0);
  const [length, setLength] = createSignal(0);
  const [speed, setSpeed] = createSignal(1);
  const [loop, setLoop] = createSignal(false);
  const [muted, setMuted] = createSignal(false);
  const [cues, setCues] = createSignal<Cue[]>([]);
  const [next, setNext] = createSignal<Film[]>([]);
  const [awake, setAwake] = createSignal(true);
  const [near, setNear] = createSignal(true);
  const [toast, setToast] = createSignal<string>();
  let root!: HTMLElement;
  let video!: HTMLVideoElement;
  let lane!: HTMLDivElement;
  let seen = 0;
  let startAt = 0;
  let startPlaying = true;
  let idle: number | undefined;
  let toastTimer: number | undefined;
  let frame = 0;
  let press: { x: number; y: number } | undefined;

  const cue = createMemo(() => {
    const now = time();
    return cues().find((one) => one.start <= now && now < one.end);
  });
  const upNext = () => (upNextShown(time(), length(), next().length > 0) ? next()[0] : undefined);

  function take(handed: Handover | null) {
    if (!handed || handed.seq <= seen) return;
    seen = handed.seq;
    keepResume();
    setFilm(handed);
    setSpeed(handed.speed);
    setLoop(handed.loop);
    setMuted(handed.muted);
    setCues(handed.subtitles ? cuesOf(handed.subtitles) : []);
    setNext(handed.next);
    setEnded(false);
    setLength(0);
    startAt = caughtUp(handed);
    startPlaying = handed.playing;
    video.src = handed.url;
    // It springs in, the way the window it came from closed into it.
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      root.animate({ scale: [0.9, 1], opacity: [0, 1] }, { duration: ARRIVE_MS, easing: getComputedStyle(root).getPropertyValue("--spring").trim() || "ease-out" });
    }
    void miniFit(place().width, handed.aspect, place().corner).catch(console.error);
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: handed.name.replace(/\.[^.]+$/, "") });
  }

  /** On to the first film after this one in its folder. */
  async function playOnward() {
    const [coming, ...after] = next();
    const now = film();
    if (!coming || !now) return;
    const [shown] = await openAudio(0, 0, 0, coming.path);
    const text = (await besideText(0, 0, 0, "srt", coming.path).catch(() => null)) ?? (await besideText(0, 0, 0, "vtt", coming.path).catch(() => null));
    take({
      ...coming,
      seq: seen + 1,
      url: convertFileSrc(shown),
      time: resumes()[coming.path] ?? 0,
      at: Date.now(),
      playing: true,
      speed: speed(),
      loop: loop(),
      muted: muted(),
      subtitles: text ?? undefined,
      aspect: now.aspect,
      next: after,
    });
  }

  /** A long film keeps its place, as the full player's does. */
  function keepResume() {
    const now = film();
    if (now && length() > RESUME_FROM_SECONDS && video.currentTime > RESUME_MARGIN_SECONDS) remember(now.path, video.currentTime);
  }

  function seek(seconds: number) {
    if (!length()) return;
    video.currentTime = Math.min(Math.max(seconds, 0), length());
    tick();
  }

  const toggle = () => {
    if (ended()) seek(0);
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  };

  function tick() {
    setTime(video.currentTime);
    lane?.style.setProperty("--at", String(length() ? video.currentTime / length() : 0));
  }

  function run() {
    cancelAnimationFrame(frame);
    tick();
    if (!video.paused) frame = requestAnimationFrame(run);
  }

  function say(text: string) {
    setToast(text);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(undefined), TOAST_MS);
  }

  function nudgeVolume(by: number) {
    setVolume(Math.round(Math.min(Math.max(volume() + by, 0), 1) * 100) / 100);
    if (muted() && by > 0) setMuted(false);
    say(`Volume ${Math.round(volume() * 100)}%`);
  }

  function stir() {
    setNear(true);
    setAwake(true);
    window.clearTimeout(idle);
    idle = window.setTimeout(() => setAwake(false), IDLE_MS);
  }

  async function close() {
    keepResume();
    video.pause();
    video.removeAttribute("src");
    video.load();
    await getCurrentWindow().close();
  }

  /** The full player takes the film on from this very moment, and this window goes. */
  async function back() {
    const now = film();
    if (!now) return;
    const handed: HandBack = { path: now.path, time: video.currentTime, at: Date.now(), playing: !video.paused, speed: speed() };
    await emitTo("main", "mini-back", handed);
    await close();
  }

  function onKeyDown(event: KeyboardEvent) {
    const key = event.key;
    if (event.ctrlKey || event.altKey) return;
    const step = event.shiftKey ? BIG_STEP_SECONDS : STEP_SECONDS;
    if (key === " " || key === "k" || key === "K" || key === "p" || key === "P") toggle();
    else if (key === "ArrowLeft") seek(video.currentTime - step);
    else if (key === "ArrowRight") seek(video.currentTime + step);
    else if (key === "ArrowUp") nudgeVolume(VOLUME_STEP);
    else if (key === "ArrowDown") nudgeVolume(-VOLUME_STEP);
    else if (key === "m" || key === "M") setMuted(!muted());
    else if (key === "l" || key === "L") setLoop(!loop());
    else if ((key === "c" || key === "C") && cues().length) setSubtitles(!subtitles());
    else if ((key === "n" || key === "N") && next().length) void playOnward().catch(console.error);
    else if (key === "Enter" || key === "f" || key === "F") void back();
    else if (key === "Escape") void close();
    else return;
    event.preventDefault();
    stir();
  }

  /** A press on the film that moves is Windows' own drag of the window; one that stays is a click. */
  function onStagePointerDown(event: PointerEvent) {
    if (event.button === 0) press = { x: event.screenX, y: event.screenY };
  }

  function onStagePointerMove(event: PointerEvent) {
    stir();
    if (!press || !(event.buttons & 1)) return (press = undefined);
    if (Math.hypot(event.screenX - press.x, event.screenY - press.y) < DRAG_PIXELS) return;
    press = undefined;
    void getCurrentWindow().startDragging();
  }

  const secondsAt = (event: PointerEvent) => {
    const box = lane.getBoundingClientRect();
    return (Math.min(Math.max(event.clientX - box.left, 0), box.width) / box.width) * length();
  };

  function onLaneDown(event: PointerEvent) {
    if (event.button !== 0 || !length()) return;
    lane.setPointerCapture(event.pointerId);
    seek(secondsAt(event));
    const move = (moved: PointerEvent) => seek(secondsAt(moved));
    const up = () => {
      lane.removeEventListener("pointermove", move);
      lane.removeEventListener("pointerup", up);
    };
    lane.addEventListener("pointermove", move);
    lane.addEventListener("pointerup", up);
  }

  createEffect(() => (video.volume = volume()));
  createEffect(() => (video.muted = muted()));
  createEffect(() => (video.loop = loop()));
  createEffect(() => (video.playbackRate = speed()));

  onMount(() => {
    const accent = saved("accent");
    if (typeof accent === "string") document.documentElement.dataset.accent = accent;
    const unlisten = [
      listen<Handover>("mini-take", (event) => take(event.payload)),
      listen("mini-hush", () => video.pause()),
      listen<[MiniPlace["corner"], number]>("mini-corner", (event) => setPlace({ corner: event.payload[0], width: Math.round(event.payload[1]) })),
    ];
    onCleanup(() => unlisten.forEach((off) => void off.then((stop) => stop())));
    void miniTake<Handover>().then(take, console.error);
    document.documentElement.addEventListener("mouseleave", () => {
      setNear(false);
      setAwake(false);
    });
    addEventListener("beforeunload", keepResume);
    stir();
  });

  onCleanup(() => {
    cancelAnimationFrame(frame);
    window.clearTimeout(idle);
    window.clearTimeout(toastTimer);
  });

  return (
    <main
      ref={root}
      class="mini"
      data-awake={awake() || !playing() || undefined}
      data-away={!near() || undefined}
      data-playing={playing() || undefined}
      tabindex="0"
      onKeyDown={onKeyDown}
      onPointerMove={stir}
      onWheel={(event) => {
        event.preventDefault();
        nudgeVolume(event.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP);
      }}
    >
      <div
        class="mini-stage"
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onClick={toggle}
        onDblClick={() => void back()}
      >
        <video
          ref={video}
          class="mini-film"
          crossOrigin="anonymous"
          onLoadedMetadata={() => {
            setLength(video.duration);
            video.playbackRate = speed();
            const shape = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 0;
            const handed = film();
            if (shape && handed && Math.abs(shape - handed.aspect) > 0.01) {
              setFilm({ ...handed, aspect: shape });
              void miniFit(place().width, shape, place().corner).catch(console.error);
            }
            seek(startAt);
            if (startPlaying) void video.play().catch(() => {});
          }}
          onPlay={() => {
            setPlaying(true);
            setEnded(false);
            // The full player's song would play under the film otherwise.
            if (!video.muted) void emitTo("main", "mini-playing").catch(() => {});
            run();
          }}
          onPause={() => {
            setPlaying(false);
            tick();
          }}
          onSeeked={tick}
          onEnded={() => {
            if (next().length && playNext()) return void playOnward().catch(console.error);
            setEnded(true);
          }}
        />
        <Show when={subtitles() && cue()}>{(shown) => <p class="mini-cue">{shown().text}</p>}</Show>
      </div>

      <header class="mini-top">
        <span class="mini-name">{film()?.name}</span>
        <button class="mini-icon" aria-label="Back to the full player" aria-keyshortcuts="Enter F" onClick={() => void back()}>
          {ICON_BACK}
        </button>
        <button class="mini-icon" aria-label="Close" aria-keyshortcuts="Escape" onClick={() => void close()}>
          {ICON_CLOSE}
        </button>
      </header>

      <Show when={upNext()}>
        {(coming) => (
          <button class="mini-next-chip" onClick={() => void playOnward().catch(console.error)}>
            <span class="mini-next-label">Up next</span>
            <span class="mini-next-name">{coming().name}</span>
          </button>
        )}
      </Show>

      <Show when={toast()}>
        <p class="mini-toast" role="status">
          {toast()}
        </p>
      </Show>

      <footer class="mini-bottom">
        <div
          ref={lane}
          class="mini-lane"
          role="slider"
          aria-label="Position"
          aria-valuemin="0"
          aria-valuemax={Math.round(length())}
          aria-valuenow={Math.round(time())}
          aria-valuetext={`${clock(time())} of ${clock(length())}`}
          onPointerDown={onLaneDown}
        >
          <div class="mini-track" />
          <div class="mini-head" />
        </div>
        <div class="mini-bar">
          <button class="mini-icon mini-play" aria-label={playing() ? "Pause" : "Play"} aria-keyshortcuts="Space" onClick={toggle}>
            {playing() ? ICON_PAUSE : ICON_PLAY}
          </button>
          <span class="mini-time">
            {clock(time())} / {clock(length())}
          </span>
          <span class="mini-gap" />
          <button class="mini-icon mini-speed" aria-label="Speed" onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed()) + 1) % SPEEDS.length])}>
            {speed()}×
          </button>
          <Show when={cues().length}>
            <button class="mini-icon" aria-label="Subtitles" aria-keyshortcuts="C" aria-pressed={subtitles()} onClick={() => setSubtitles(!subtitles())}>
              {ICON_CAPTIONS}
            </button>
          </Show>
          <button class="mini-icon" aria-label="Loop" aria-keyshortcuts="L" aria-pressed={loop()} onClick={() => setLoop(!loop())}>
            {ICON_LOOP}
          </button>
          <Show when={next().length}>
            <button class="mini-icon" aria-label={`Next: ${next()[0].name}`} aria-keyshortcuts="N" onClick={() => void playOnward().catch(console.error)}>
              {ICON_NEXT}
            </button>
          </Show>
          <button class="mini-icon" aria-label={muted() ? "Sound on" : "Mute"} aria-keyshortcuts="M" aria-pressed={muted()} onClick={() => setMuted(!muted())}>
            {muted() ? ICON_MUTED : ICON_VOLUME}
          </button>
          <input
            class="mini-volume"
            type="range"
            aria-label="Volume"
            min="0"
            max="1"
            step="0.05"
            value={volume()}
            style={{ "--fill": volume() }}
            onInput={(event) => setVolume(event.currentTarget.valueAsNumber)}
          />
        </div>
      </footer>
    </main>
  );
}
