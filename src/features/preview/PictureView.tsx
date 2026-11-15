import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { PictureEdit, PictureFormat, Thumb } from "../../api";
import { ToolCog } from "../../ui/Controls";
import { draw } from "./QuickPreview";
import { cameraFacts, hexAt, tintOf } from "./pictureFacts";
import { Minimap } from "./Minimap";
import { minimapShown, setMinimapShown, sharpPixels, VIEWER_SETTINGS } from "./viewerPrefs";
import { panFor, viewWindow } from "./zoomView";

const ICON_ZOOM_IN = "";
const ICON_ZOOM_OUT = "";
const ICON_FIT = "";
const ICON_TURN = "";

const ICON_PLAY = "\uE768";
const ICON_PAUSE = "\uE769";
const ICON_BACK = "\uE892";
const ICON_ON = "\uE893";
const ICON_SHOW = "\uE786";
const ICON_PICK = "\uEF3C";
const ICON_COPY = "\uE8C8";
const ICON_TOOLS = "\uE70F";
/** Sizes a smaller copy can take, by its longer side. */
const COPY_EDGES = [3840, 2560, 1920, 1280, 800];
const FORMATS: [PictureFormat, string][] = [["png", "PNG"], ["jpeg", "JPEG"], ["tiff", "TIFF"], ["bmp", "BMP"]];
/** A frame that names no time of its own stays this long, as browsers do. */
const FRAME_MS = 100;
const SAID_MS = 1600;

/** Windows draws pictures this big at most, so 1:1 past it is the biggest one stretched. */
const MOST_EDGE = 4096;
const MOST_ZOOM = 16;
const STEP = 1.25;
/** How far one notch of the wheel zooms. */
const WHEEL = 0.0015;

export interface PictureViewProps {
  load: (edge: number) => Promise<Thumb | null>;
  size: () => Promise<[number, number] | null>;
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
  note: (text: string | undefined) => void;
  /** The file itself, for a picture that moves. Left out for one that would have to download. */
  bytes?: () => Promise<ArrayBuffer>;
  /** The MIME type of a kind of picture that can move. */
  moving?: string;
  /** What Windows knows about the file, for the camera chips. */
  facts?: () => Promise<[group: string, label: string, value: string][]>;
  /** The slideshow, which outlives one picture. */
  slideshow?: () => boolean;
  onSlideshow?: (on: boolean) => void;
  /** Changes to the file, for a picture on disk. */
  tools?: PictureTools;
}

export interface PictureTools {
  /** Its format is one Windows writes, so a turn can be saved into the file. */
  canSave: boolean;
  /** The file's own format, which Convert leaves out. */
  format?: PictureFormat;
  /** Runs an edit as a job. True once it is done. */
  run: (edit: PictureEdit) => Promise<boolean>;
  wallpaper: () => Promise<boolean>;
}

/**
 * A picture that fits the window, with wheel zoom toward the pointer, drag to pan, 1:1 and turns.
 * It starts at the window's size and loads the full picture once it is zoomed past that.
 */
export function PictureView(live: PictureViewProps) {
  // The preview's props follow the row it shows. This view stays with the file it opened on.
  const props = { ...live };
  let stage!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  /** The picture's own pixels, or those drawn when Windows can't say. */
  const [natural, setNatural] = createSignal<[number, number]>();
  /** Null fits the window. 1 shows one of the picture's pixels on each screen pixel. */
  const [zoom, setZoom] = createSignal<number | null>(null);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  /** Quarter turns. It only grows or shrinks, so a turn always spins the short way. */
  const [turn, setTurn] = createSignal(0);
  /** Mirrored left to right, before the turn, as a saved turn writes it. */
  const [flip, setFlip] = createSignal(false);
  /** The turn as the file would take it: quarter turns clockwise, 0 to 3. */
  const quarters = () => ((turn() % 4) + 4) % 4;
  const [working, setWorking] = createSignal(false);
  let toolsButton: HTMLButtonElement | undefined;
  let toolsPanel: HTMLDivElement | undefined;
  const [box, setBox] = createSignal({ width: 0, height: 0 });
  const [dragging, setDragging] = createSignal(false);
  let drawnEdge = 0;
  let loadingFull = false;
  let gone = false;
  /** A soft colour from the picture for the backdrop, and whether any of it is see-through. */
  const [look, setLook] = createSignal<{ tint: string; clear: boolean }>();
  const [chips, setChips] = createSignal<string[]>([]);
  const [picking, setPicking] = createSignal(false);
  /** What was just copied, said for a moment. */
  const [said, setSaid] = createSignal<{ text: string; color?: string }>();
  /** For a picture that moves: its frames, which one shows, and whether it plays. */
  const [frames, setFrames] = createSignal(0);
  const [frame, setFrame] = createSignal(0);
  const [playing, setPlaying] = createSignal(true);
  let decoder: ImageDecoder | undefined;
  let frameTimer: number | undefined;
  let saidTimer: number | undefined;

  function say(text: string, color?: string) {
    setSaid({ text, color });
    window.clearTimeout(saidTimer);
    saidTimer = window.setTimeout(() => setSaid(undefined), SAID_MS);
  }

  const fit = createMemo(() => {
    const own = natural();
    const { width, height } = box();
    if (!own || !width) return 1;
    const [w, h] = turn() % 2 ? [own[1], own[0]] : own;
    return Math.min((width * devicePixelRatio) / w, (height * devicePixelRatio) / h, 1);
  });
  const scale = () => zoom() ?? fit();
  /** The picture's size on screen as it now shows, turned. */
  const shownSize = createMemo(() => {
    const own = natural() ?? [1, 1];
    const [w, h] = turn() % 2 ? [own[1], own[0]] : own;
    return { width: (w / devicePixelRatio) * scale(), height: (h / devicePixelRatio) * scale() };
  });
  const mapped = () => minimapShown() && zoom() !== null && (shownSize().width > box().width + 1 || shownSize().height > box().height + 1);

  async function load(edge: number) {
    const picture = await props.load(edge);
    if (gone || !picture) return picture;
    // A picture that moves draws its own frames, and a still of it would stop them.
    if (frames()) return picture;
    draw(canvas, picture);
    drawnEdge = Math.max(picture.width, picture.height);
    if (!look()) setLook(tintOf(picture.pixels));
    return picture;
  }

  /** The full picture, once the view shows more of it than the first one had. */
  function sharpen() {
    const own = natural();
    if (!own || loadingFull || frames()) return;
    const needed = Math.min(Math.max(...own) * scale(), MOST_EDGE);
    if (needed <= drawnEdge * 1.05) return;
    loadingFull = true;
    load(Math.min(Math.max(...own), MOST_EDGE)).catch(console.error);
  }

  /** Zooms to `next`, keeping the point `at` (from the middle of the stage) where it is. */
  function zoomTo(next: number | null, at = { x: 0, y: 0 }) {
    const before = scale();
    const after = next === null ? fit() : Math.min(Math.max(next, Math.min(fit(), 0.05)), MOST_ZOOM);
    const from = pan();
    const ratio = after / before;
    setZoom(next === null || Math.abs(after - fit()) < 0.001 ? null : after);
    setPan(zoom() === null ? { x: 0, y: 0 } : { x: at.x - (at.x - from.x) * ratio, y: at.y - (at.y - from.y) * ratio });
    sharpen();
  }

  const fromMiddle = (event: MouseEvent) => {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    zoomTo(scale() * Math.exp(-event.deltaY * WHEEL), fromMiddle(event));
  }

  /** Shows frame `at` of a picture that moves, and the next one after its time when playing. */
  async function showFrame(at: number) {
    window.clearTimeout(frameTimer);
    if (!decoder || gone) return;
    const { image } = await decoder.decode({ frameIndex: at });
    if (gone) return image.close();
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    canvas.getContext("2d")!.drawImage(image, 0, 0);
    const wait = (image.duration ?? 0) / 1000 || FRAME_MS;
    image.close();
    setFrame(at);
    if (playing()) frameTimer = window.setTimeout(() => void showFrame((at + 1) % frames()).catch(console.error), wait);
  }

  /** Reads the file as a picture that moves. One that turns out to be still is left as drawn. */
  async function animate() {
    if (!props.bytes || !props.moving || typeof ImageDecoder === "undefined") return;
    const reader = new ImageDecoder({ data: await props.bytes(), type: props.moving });
    await reader.tracks.ready;
    const track = reader.tracks.selectedTrack;
    if (gone || !track?.animated || track.frameCount < 2) return reader.close();
    const { image } = await reader.decode({ frameIndex: 0 });
    const size: [number, number] = [image.displayWidth, image.displayHeight];
    image.close();
    if (gone) return reader.close();
    decoder = reader;
    canvas.width = size[0];
    canvas.height = size[1];
    setNatural(size);
    setFrames(track.frameCount);
    // Those who want no motion start on a still, and play it themselves.
    setPlaying(!matchMedia("(prefers-reduced-motion: reduce)").matches);
    await showFrame(0);
  }

  function play(on: boolean) {
    setPlaying(on);
    void showFrame(on ? (frame() + 1) % frames() : frame()).catch(console.error);
  }

  function stepFrame(by: number) {
    setPlaying(false);
    void showFrame((frame() + by + frames()) % frames()).catch(console.error);
  }

  /** The colour under the pointer, copied as hex. */
  function pick(event: MouseEvent) {
    const x = Math.floor((event.offsetX * canvas.width) / canvas.clientWidth);
    const y = Math.floor((event.offsetY * canvas.height) / canvas.clientHeight);
    const hex = hexAt(canvas.getContext("2d")!.getImageData(x, y, 1, 1).data);
    navigator.clipboard.writeText(hex).then(() => say(`Copied ${hex}`, hex), console.error);
  }

  function copyPicture() {
    canvas.toBlob((blob) => {
      if (!blob) return;
      navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(() => say("Picture copied"), console.error);
    }, "image/png");
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button === 0 && picking() && event.target === canvas) return pick(event);
    if (event.button !== 0 || zoom() === null) return;
    stage.setPointerCapture(event.pointerId);
    setDragging(true);
    const start = { x: event.clientX - pan().x, y: event.clientY - pan().y };
    const move = (moved: PointerEvent) => setPan({ x: moved.clientX - start.x, y: moved.clientY - start.y });
    const up = () => {
      setDragging(false);
      stage.removeEventListener("pointermove", move);
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up, { once: true });
    stage.addEventListener("pointercancel", up, { once: true });
  }

  const tools = {
    in: () => zoomTo(scale() * STEP),
    out: () => zoomTo(scale() / STEP),
    actual: () => zoomTo(zoom() === null ? 1 : null),
    fit: () => zoomTo(null),
    turn: (by: number) => {
      setTurn(turn() + by);
      zoomTo(null);
    },
    /** A mirror on screen, left to right, whichever way the picture stands now. */
    flip: () => {
      setTurn(-turn());
      setFlip(!flip());
    },
  };

  /** Runs one of the file tools, and says how it went. */
  async function work(job: () => Promise<boolean>, done: string) {
    toolsPanel?.hidePopover();
    if (working()) return;
    setWorking(true);
    try {
      if (await job()) say(done);
    } catch (reason) {
      say(String(reason));
    } finally {
      if (!gone) setWorking(false);
    }
  }
  const edit = (change: PictureEdit, done: string) => work(() => props.tools!.run(change), done);
  // The saved file comes back as a new view, standing as it was turned here.
  const saveTurn = () => edit({ kind: "turn", quarters: quarters(), flip: flip() }, "Turn saved");
  const turned = () => quarters() !== 0 || flip();
  const smaller = () => COPY_EDGES.filter((edge) => edge < Math.max(...(natural() ?? [0])));

  function toggleTools() {
    if (!toolsButton || !toolsPanel) return;
    if (toolsPanel.matches(":popover-open")) return toolsPanel.hidePopover();
    toolsPanel.showPopover();
    const { right, bottom } = toolsButton.getBoundingClientRect();
    const { width, height } = toolsPanel.getBoundingClientRect();
    toolsPanel.style.left = `${Math.max(4, right - width)}px`;
    toolsPanel.style.top = `${bottom + 6 + height > innerHeight ? Math.max(4, bottom - 34 - height) : bottom + 6}px`;
  }

  props.keys((event) => {
    const key = event.key.toLowerCase();
    if (event.ctrlKey && key === "c" && !getSelection()?.toString()) return copyPicture(), true;
    if (event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement && event.target.type !== "range") return false;
    if (key === "+" || key === "=") tools.in();
    else if (key === "-") tools.out();
    else if (key === "1") zoomTo(1);
    else if (key === "0") tools.fit();
    else if (key === "r") tools.turn(event.shiftKey ? -1 : 1);
    else if (key === "h") tools.flip();
    else if (key === "i") setPicking(!picking());
    else if (key === "m") setMinimapShown(!minimapShown());
    else if (key === "s" && props.onSlideshow) props.onSlideshow(!props.slideshow?.());
    else if (key === "p" && frames()) play(!playing());
    else if (key === "," && frames()) stepFrame(-1);
    else if (key === "." && frames()) stepFrame(1);
    else if (key === "escape" && picking()) setPicking(false);
    else return false;
    return true;
  });

  onMount(() => {
    const measure = () => setBox({ width: stage.clientWidth, height: stage.clientHeight });
    const watch = new ResizeObserver(measure);
    watch.observe(stage);
    onCleanup(() => watch.disconnect());
    measure();
    const edge = Math.ceil(Math.max(stage.clientWidth, stage.clientHeight) * devicePixelRatio);
    Promise.all([load(edge), props.size().catch(() => null)])
      .then(([picture, own]) => {
        if (gone) return;
        const size = own ?? (picture ? ([picture.width, picture.height] as [number, number]) : undefined);
        setNatural(size);
        if (own) props.note(`${own[0].toLocaleString()} × ${own[1].toLocaleString()} px`);
        return animate();
      })
      .catch(console.error);
    props.facts?.().then((list) => !gone && setChips(cameraFacts(list)), console.error);
  });

  onCleanup(() => {
    gone = true;
    window.clearTimeout(frameTimer);
    window.clearTimeout(saidTimer);
    decoder?.close();
    props.keys(undefined);
    props.note(undefined);
  });

  const style = () => {
    const own = natural();
    const { x, y } = pan();
    return {
      visibility: own ? undefined : ("hidden" as const),
      width: own ? `${own[0] / devicePixelRatio}px` : undefined,
      height: own ? `${own[1] / devicePixelRatio}px` : undefined,
      transform: `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${turn() * 90}deg) scaleX(${flip() ? -1 : 1}) scale(${scale()})`,
    };
  };

  return (
    <div
      ref={stage}
      class="picture-stage"
      data-sharp={sharpPixels() || undefined}
      data-zoomed={zoom() !== null || undefined}
      data-dragging={dragging() || undefined}
      data-clear={look()?.clear || undefined}
      data-picking={picking() || undefined}
      style={{ "--picture-tint": look()?.tint ?? "transparent" }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onDblClick={(event) => !picking() && zoomTo(zoom() === null ? 1 : null, zoom() === null ? fromMiddle(event) : undefined)}
    >
      <canvas ref={canvas} class="preview-picture" style={style()} />
      <Show when={mapped()}>
        <Minimap
          source={() => canvas}
          aspect={() => shownSize().width / shownSize().height}
          turn={turn}
          view={() => viewWindow(box(), shownSize(), pan())}
          onMove={(center) => setPan(panFor(center, shownSize()))}
          live={frames() > 0}
        />
      </Show>
      <Show when={chips().length > 0}>
        <ul class="picture-chips" aria-label="Camera">
          <For each={chips()}>{(chip) => <li>{chip}</li>}</For>
        </ul>
      </Show>
      <Show when={said()}>
        {(now) => (
          <p class="picture-said" role="status">
            <Show when={now().color}>
              <span class="picture-swatch" style={{ background: now().color }} />
            </Show>
            {now().text}
          </p>
        )}
      </Show>
      <div class="preview-tools picture-tools" role="toolbar" aria-label="Picture">
        <Show when={frames()}>
          <button class="strip-icon" aria-label="Frame back" aria-keyshortcuts="," onClick={() => stepFrame(-1)}>
            {ICON_BACK}
          </button>
          <button class="strip-icon" aria-label={playing() ? "Pause" : "Play"} aria-keyshortcuts="P" onClick={() => play(!playing())}>
            {playing() ? ICON_PAUSE : ICON_PLAY}
          </button>
          <button class="strip-icon" aria-label="Frame on" aria-keyshortcuts="." onClick={() => stepFrame(1)}>
            {ICON_ON}
          </button>
          <span class="zoom-chip picture-frame">
            {frame() + 1} / {frames()}
          </span>
        </Show>
        <button class="strip-icon" aria-label="Zoom out" aria-keyshortcuts="-" onClick={tools.out}>
          {ICON_ZOOM_OUT}
        </button>
        <button class="zoom-chip" aria-label="Zoom, click to fit" aria-keyshortcuts="0" onClick={tools.fit}>
          {Math.round(scale() * 100)}%
        </button>
        <button class="strip-icon" aria-label="Zoom in" aria-keyshortcuts="+" onClick={tools.in}>
          {ICON_ZOOM_IN}
        </button>
        <button class="strip-icon zoom-actual" aria-label="Actual size" aria-keyshortcuts="1" aria-pressed={zoom() === 1} onClick={tools.actual}>
          1:1
        </button>
        <button class="strip-icon" aria-label="Fit to window" aria-keyshortcuts="0" aria-pressed={zoom() === null} onClick={tools.fit}>
          {ICON_FIT}
        </button>
        <button class="strip-icon" aria-label="Turn right" aria-keyshortcuts="R" onClick={() => tools.turn(1)}>
          {ICON_TURN}
        </button>
        <Show when={props.tools?.canSave && turned() && !frames()}>
          <button class="preview-chip picture-save-turn" disabled={working()} onClick={() => void saveTurn()}>
            Save turn
          </button>
        </Show>
        <button class="strip-icon" aria-label="Pick a colour and copy it" aria-keyshortcuts="I" aria-pressed={picking()} onClick={() => setPicking(!picking())}>
          {ICON_PICK}
        </button>
        <button class="strip-icon" aria-label="Copy picture" aria-keyshortcuts="Control+C" onClick={copyPicture}>
          {ICON_COPY}
        </button>
        <Show when={props.onSlideshow}>
          <button
            class="strip-icon"
            aria-label="Slideshow"
            aria-keyshortcuts="S"
            aria-pressed={props.slideshow?.()}
            onClick={() => props.onSlideshow!(!props.slideshow?.())}
          >
            {ICON_SHOW}
          </button>
        </Show>
        <Show when={props.tools}>
          {(own) => (
            <>
              <button ref={toolsButton} class="strip-icon" aria-label="Picture tools" aria-haspopup="dialog" disabled={working()} onClick={toggleTools}>
                {ICON_TOOLS}
              </button>
              <div
                ref={toolsPanel}
                class="cog-panel picture-tools-panel"
                popover="auto"
                role="dialog"
                aria-label="Picture tools"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <p class="picture-tools-head">This picture</p>
                <div class="picture-tools-row">
                  <button class="preview-chip" onClick={() => (toolsPanel?.hidePopover(), tools.flip())}>
                    Mirror <kbd>H</kbd>
                  </button>
                  <Show when={own().canSave && !frames()}>
                    <button class="preview-chip" disabled={!turned()} onClick={() => void saveTurn()}>
                      Save turn
                    </button>
                  </Show>
                  <button class="preview-chip" onClick={() => void work(own().wallpaper, "Set as the wallpaper. Ctrl+Z puts the old one back.")}>
                    Set as wallpaper
                  </button>
                </div>
                <Show when={smaller().length > 0}>
                  <p class="picture-tools-head">Smaller copy</p>
                  <div class="picture-tools-row">
                    <For each={smaller()}>
                      {(edge) => (
                        <button class="preview-chip" onClick={() => void edit({ kind: "resize", longest: edge }, "Smaller copy made beside it")}>
                          {edge.toLocaleString()} px
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
                <p class="picture-tools-head">Copy as</p>
                <div class="picture-tools-row">
                  <For each={FORMATS.filter(([format]) => format !== own().format)}>
                    {([format, name]) => (
                      <button class="preview-chip" onClick={() => void edit({ kind: "convert", format }, `${name} copy made beside it`)}>
                        {name}
                      </button>
                    )}
                  </For>
                  <button class="preview-chip" onClick={() => void edit({ kind: "share" }, "Copy to share made beside it")}>
                    To share
                  </button>
                </div>
                <p class="cog-note">A copy to share is a smaller JPEG with no place or camera in it. Copies go beside the picture.</p>
              </div>
            </>
          )}
        </Show>
        <ToolCog label="Picture settings" items={VIEWER_SETTINGS.Pictures} />
      </div>
    </div>
  );
}
