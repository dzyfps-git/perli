import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { ToolCog } from "../../ui/Controls";
import { audio, setVolume, volume } from "./nowPlaying";
import { clock, laneDrag, remember, resumes } from "./Player";
import { cuesOf, type Cue } from "./timedText";
import { setSubtitles, subtitles, videoMuted, VIEWER_SETTINGS } from "./viewerPrefs";

const ICON_PLAY = "";
const ICON_PAUSE = "";
const ICON_LOOP = "";
const ICON_CLEAR = "";
const ICON_VOLUME = "";
const ICON_MUTED = "";
const ICON_CAPTIONS = "";
const ICON_FRAME = "";
const SPEEDS = [1, 1.25, 1.5, 2, 0.25, 0.5, 0.75];
const STEP_SECONDS = 5;
const BIG_STEP_SECONDS = 30;
const RESUME_FROM_SECONDS = 10 * 60;
const RESUME_MARGIN_SECONDS = 30;
const RESUME_SAVE_MS = 5000;
/** Until the film says how fast its frames come, a frame step takes this long. */
const FRAME_SECONDS = 1 / 30;
const SCOUT_WIDTH = 160;
const SAVED_SHOWN_MS = 2400;

export interface VideoViewProps {
  path: string;
  /** Where the window streams the film from. */
  load: () => Promise<string>;
  /** The `.srt` or `.vtt` file beside the film, if there is one. */
  subtitles: () => Promise<string | null>;
  /** Saves a PNG of the frame shown, and gives its name. */
  saveFrame: (seconds: number, png: ArrayBuffer) => Promise<string>;
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
  note: (text: string | undefined) => void;
}

/**
 * A film, with the player's own strip under it: a lane to seek and loop a part on, which shows
 * the frame under the pointer, frame steps, speeds, subtitles from the file beside it, and a
 * button that saves the frame shown as a picture.
 */
export function VideoView(live: VideoViewProps) {
  const props = { ...live };
  const [url, setUrl] = createSignal<string>();
  const [problem, setProblem] = createSignal<string>();
  const [playing, setPlaying] = createSignal(false);
  const [time, setTime] = createSignal(0);
  const [length, setLength] = createSignal(0);
  const [loop, setLoop] = createSignal(false);
  const [section, setSection] = createSignal<[number, number]>();
  const [hover, setHover] = createSignal<number>();
  const [speed, setSpeed] = createSignal(1);
  const [muted, setMuted] = createSignal(videoMuted());
  const [cues, setCues] = createSignal<Cue[]>([]);
  const [saved, setSaved] = createSignal<string>();
  let video!: HTMLVideoElement;
  let scout: HTMLVideoElement | undefined;
  let scoutPicture: HTMLCanvasElement | undefined;
  let lane!: HTMLDivElement;
  let gone = false;
  let frame = 0;
  let lastSave = 0;
  let frameSeconds = FRAME_SECONDS;
  let savedTimer: ReturnType<typeof setTimeout> | undefined;

  props
    .load()
    .then((found) => gone || setUrl(found))
    .catch((reason) => gone || setProblem(String(reason)));
  props
    .subtitles()
    .then((text) => gone || !text || setCues(cuesOf(text)))
    .catch(() => {});

  const cue = createMemo(() => {
    const now = time();
    return cues().find((one) => one.start <= now && now < one.end);
  });

  function seek(seconds: number) {
    if (!length()) return;
    video.currentTime = Math.min(Math.max(seconds, 0), length());
    tick();
  }

  const toggle = () => (video.paused ? void video.play().catch(() => {}) : video.pause());

  /** One frame on or back, from a stop. */
  function stepFrame(by: number) {
    video.pause();
    seek(video.currentTime + by * frameSeconds);
  }

  function tick() {
    const now = video.currentTime;
    const part = section();
    if (part && !video.paused && now >= part[1]) video.currentTime = part[0];
    setTime(video.currentTime);
    lane?.style.setProperty("--at", String(length() ? video.currentTime / length() : 0));
    if (length() > RESUME_FROM_SECONDS && now > RESUME_MARGIN_SECONDS && Date.now() - lastSave > RESUME_SAVE_MS) {
      lastSave = Date.now();
      remember(props.path, now);
    }
  }

  function run() {
    cancelAnimationFrame(frame);
    tick();
    if (!video.paused && !gone) frame = requestAnimationFrame(run);
  }

  /** Learns how long a frame lasts from two frames shown one after the other. */
  function measure() {
    let last: VideoFrameCallbackMetadata | undefined;
    const watch = (_: number, shown: VideoFrameCallbackMetadata) => {
      if (gone) return;
      if (last && shown.presentedFrames - last.presentedFrames === 1 && shown.mediaTime > last.mediaTime) {
        frameSeconds = shown.mediaTime - last.mediaTime;
        return;
      }
      last = shown;
      video.requestVideoFrameCallback(watch);
    };
    if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(watch);
  }

  function onMetadata() {
    setLength(video.duration);
    video.playbackRate = speed();
    props.note(video.videoWidth ? `${video.videoWidth} × ${video.videoHeight}` : undefined);
    const at = resumes()[props.path];
    if (video.duration > RESUME_FROM_SECONDS && at > RESUME_MARGIN_SECONDS && at < video.duration - RESUME_MARGIN_SECONDS) seek(at);
    measure();
  }

  function onPlay() {
    setPlaying(true);
    // A film with sound and a song at once would be noise, so the song waits.
    if (!video.muted) audio.pause();
    run();
  }

  async function grab() {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    if (!canvas.width) return;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
    if (!blob || gone) return;
    try {
      const name = await props.saveFrame(video.currentTime, await blob.arrayBuffer());
      setSaved(`Saved ${name}`);
    } catch (reason) {
      setSaved(String(reason));
    }
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => setSaved(undefined), SAVED_SHOWN_MS);
  }

  /** The frame under the pointer, from a second, silent copy of the film. */
  function look(seconds: number) {
    if (!scout || scout.readyState < 1 || scout.seeking) return;
    scout.currentTime = seconds;
  }

  function drawScout() {
    if (!scout || !scoutPicture || !scout.videoWidth) return;
    scoutPicture.width = SCOUT_WIDTH * devicePixelRatio;
    scoutPicture.height = Math.round((scoutPicture.width * scout.videoHeight) / scout.videoWidth);
    scoutPicture.getContext("2d")!.drawImage(scout, 0, 0, scoutPicture.width, scoutPicture.height);
  }

  props.keys((event) => {
    if (event.altKey) return false;
    const key = event.key;
    if (event.ctrlKey) {
      if (key.toLowerCase() !== "s") return false;
      void grab();
      return true;
    }
    const step = event.shiftKey ? BIG_STEP_SECONDS : STEP_SECONDS;
    if (key === "ArrowLeft") seek(video.currentTime - step);
    else if (key === "ArrowRight") seek(video.currentTime + step);
    else if (key === "p" || key === "P" || key === "k") toggle();
    else if (key === ",") stepFrame(-1);
    else if (key === ".") stepFrame(1);
    else if (key === "l" || key === "L") setLoop(!loop());
    else if (key === "m" || key === "M") setMuted(!muted());
    else if ((key === "c" || key === "C") && cues().length) setSubtitles(!subtitles());
    else if (/^[0-9]$/.test(key)) seek((length() * Number(key)) / 10);
    else return false;
    return true;
  });

  createEffect(() => (video.volume = volume()));
  createEffect(() => (video.muted = muted()));
  createEffect(() => (video.loop = loop()));
  createEffect(() => (video.playbackRate = speed()));
  createEffect(() => {
    const at = hover();
    if (at !== undefined) look(at);
  });

  onMount(() => video.focus({ preventScroll: true }));

  onCleanup(() => {
    gone = true;
    cancelAnimationFrame(frame);
    clearTimeout(savedTimer);
    if (length() > RESUME_FROM_SECONDS && video.currentTime > RESUME_MARGIN_SECONDS) remember(props.path, video.currentTime);
    video.pause();
    video.removeAttribute("src");
    video.load();
    props.keys(undefined);
    props.note(undefined);
  });

  const secondsAt = (event: PointerEvent) => {
    const box = lane.getBoundingClientRect();
    return (Math.min(Math.max(event.clientX - box.left, 0), box.width) / box.width) * length();
  };
  const percent = (seconds: number) => `${length() ? (seconds / length()) * 100 : 0}%`;

  return (
    <div class="video-view" data-playing={playing() || undefined}>
      <div class="video-stage" onClick={toggle} onDblClick={(event) => event.stopPropagation()}>
        <video
          ref={video}
          class="video-film"
          src={url()}
          crossOrigin="anonymous"
          autoplay
          muted={videoMuted()}
          tabindex="-1"
          onPlay={onPlay}
          onPause={() => {
            setPlaying(false);
            tick();
          }}
          onLoadedMetadata={onMetadata}
          onSeeked={tick}
          onError={() => setProblem("This film can't play here. Windows' own player may open it.")}
        />
        <Show when={subtitles() && cue()}>{(shown) => <p class="video-cue">{shown().text}</p>}</Show>
        <Show when={saved()}>
          <p class="video-saved" role="status">
            {saved()}
          </p>
        </Show>
        <Show when={problem()}>
          <p class="preview-note" role="alert">
            {problem()}
          </p>
        </Show>
      </div>
      <Show when={url()}>
        {(src) => (
          <video
            ref={scout}
            class="video-scout"
            src={src()}
            crossOrigin="anonymous"
            muted
            preload="auto"
            aria-hidden="true"
            onSeeked={drawScout}
          />
        )}
      </Show>
      <div class="video-strip">
        <div
          ref={lane}
          class="player-lane video-lane"
          role="slider"
          aria-label="Position"
          aria-valuemin="0"
          aria-valuemax={Math.round(length())}
          aria-valuenow={Math.round(time())}
          aria-valuetext={`${clock(time())} of ${clock(length())}`}
          onPointerDown={(event) => event.button === 0 && length() && laneDrag(lane, event, secondsAt, section, setSection, seek)}
          onPointerMove={(event) => setHover(secondsAt(event))}
          onPointerLeave={() => setHover(undefined)}
        >
          <div class="video-track" />
          <Show when={section()}>
            {(part) => <div class="lane-section" style={{ left: percent(part()[0]), width: percent(part()[1] - part()[0]) }} />}
          </Show>
          <div class="lane-head" />
          <Show when={hover() !== undefined}>
            <div class="lane-tip video-tip" style={{ left: percent(hover()!) }}>
              <canvas ref={scoutPicture} class="video-scout-picture" />
              {clock(hover()!)}
            </div>
          </Show>
        </div>
        <div class="song-bar">
          <button class="strip-icon song-play" aria-label={playing() ? "Pause" : "Play"} aria-keyshortcuts="P" onClick={toggle}>
            {playing() ? ICON_PAUSE : ICON_PLAY}
          </button>
          <span class="song-time">
            {clock(time())} / {clock(length())}
          </span>
          <span class="song-gap" />
          <button class="strip-icon" aria-label="Back one frame" aria-keyshortcuts="," onClick={() => stepFrame(-1)}>
            ‹
          </button>
          <button class="strip-icon" aria-label="On one frame" aria-keyshortcuts="." onClick={() => stepFrame(1)}>
            ›
          </button>
          <Show when={section()}>
            <button class="strip-icon" aria-label="Stop looping this part" onClick={() => setSection(undefined)}>
              {ICON_CLEAR}
            </button>
          </Show>
          <button class="strip-icon song-speed" aria-label="Speed" onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed()) + 1) % SPEEDS.length])}>
            {speed()}×
          </button>
          <button class="strip-icon" aria-label="Loop" aria-keyshortcuts="L" aria-pressed={loop()} onClick={() => setLoop(!loop())}>
            {ICON_LOOP}
          </button>
          <Show when={cues().length}>
            <button class="strip-icon" aria-label="Subtitles" aria-keyshortcuts="C" aria-pressed={subtitles()} onClick={() => setSubtitles(!subtitles())}>
              {ICON_CAPTIONS}
            </button>
          </Show>
          <button class="strip-icon" aria-label="Save this frame as a picture" aria-keyshortcuts="Control+S" onClick={() => void grab()}>
            {ICON_FRAME}
          </button>
          <button
            class="strip-icon"
            aria-label={muted() ? "Sound on" : "Mute"}
            aria-keyshortcuts="M"
            aria-pressed={muted()}
            onClick={() => setMuted(!muted())}
          >
            {muted() ? ICON_MUTED : ICON_VOLUME}
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
          <ToolCog label="Video settings" items={VIEWER_SETTINGS.Video} />
        </div>
      </div>
    </div>
  );
}
