import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { COPY_EDGES, PICTURE_FORMATS, type PictureEdit, type PictureFormat, type Thumb } from "../../api";
import { ToolCog } from "../../ui/Controls";
import { formatSize } from "../../ui/format";
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
/** A frame that names no time of its own stays this long, as browsers do. */
const FRAME_MS = 100;
const SAID_MS = 1600;

/** Windows draws pictures this big at most, so 1:1 past it is the biggest one stretched. */
const MOST_EDGE = 4096;
const MOST_ZOOM = 16;
const STEP = 1.25;
/** How far one notch of the wheel zooms. */
const WHEEL = 0.0015;
/** Sizes are guessed from a copy this long on its longer side, whatever size the copy will be. */
const GUESS_EDGE = 1024;
/** A crop smaller than this on screen is a slip, not a choice. */
const LEAST_CROP = 4;
/** Each copy tool's own JPEG quality, as Perli writes it. */
const QUALITY = 0.92;
const SHARE_QUALITY = 0.85;
const SHARE_EDGE = 2048;
/** A BMP's header before its pixels. */
const BMP_HEADER = 54;

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
  /** Offers to save a turn the picture was left with, once it is gone from view. */
  offerTurn?: (edit: PictureEdit) => void;
}

/** Where a crop is, on the stage. */
interface CropBox {
  left: number;
  top: number;
  width: number;
  height: number;
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
  /** Mirrored left to right on screen, after the turn, so a mirror never spins the picture. */
  const [flip, setFlip] = createSignal(false);
  /** The turn as the file takes it: a mirror first, then quarter turns clockwise, 0 to 3. A mirror
   *  after a turn is the same as the mirror first and the turn the other way round. */
  const quarters = () => {
    const quarter = flip() ? -turn() : turn();
    return ((quarter % 4) + 4) % 4;
  };
  /** Choosing a part of the picture to copy, and the part chosen so far. */
  const [cropping, setCropping] = createSignal(false);
  const [cropBox, setCropBox] = createSignal<CropBox>();
  /** Bytes per pixel each kind of copy takes, guessed from this picture. */
  const [rates, setRates] = createSignal<{ png: number; jpeg: number; share: number }>();
  /** A turn being saved, or saved, which leaving needs no offer for. */
  let kept = false;
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
    // The box was drawn over the picture as it showed, which a zoom moves.
    setCropBox(undefined);
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

  /** The picture's place on the stage, as much of it as shows. */
  function shownArea() {
    const area = canvas.getBoundingClientRect();
    const origin = stage.getBoundingClientRect();
    return {
      origin,
      area,
      left: Math.max(area.left - origin.left, 0),
      top: Math.max(area.top - origin.top, 0),
      right: Math.min(area.right - origin.left, origin.width),
      bottom: Math.min(area.bottom - origin.top, origin.height),
    };
  }

  /** A drag draws the part to keep, never past the picture. Shift keeps it square. */
  function drawCrop(event: PointerEvent) {
    const { origin, left, top, right, bottom } = shownArea();
    const at = (moved: PointerEvent) => ({
      x: Math.min(Math.max(moved.clientX - origin.left, left), right),
      y: Math.min(Math.max(moved.clientY - origin.top, top), bottom),
    });
    const from = at(event);
    stage.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent) => {
      const to = at(moved);
      let [width, height] = [to.x - from.x, to.y - from.y];
      if (moved.shiftKey) {
        const side = Math.min(Math.abs(width), Math.abs(height));
        [width, height] = [Math.sign(width) * side, Math.sign(height) * side];
      }
      setCropBox({ left: Math.min(from.x, from.x + width), top: Math.min(from.y, from.y + height), width: Math.abs(width), height: Math.abs(height) });
    };
    const up = () => stage.removeEventListener("pointermove", move);
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up, { once: true });
    stage.addEventListener("pointercancel", up, { once: true });
  }

  /** The crop as shares of the whole picture, which is what a saved crop takes. */
  function cropShares() {
    const chosen = cropBox();
    if (!chosen || chosen.width < LEAST_CROP || chosen.height < LEAST_CROP) return undefined;
    const { origin, area } = shownArea();
    return {
      left: (chosen.left + origin.left - area.left) / area.width,
      top: (chosen.top + origin.top - area.top) / area.height,
      width: chosen.width / area.width,
      height: chosen.height / area.height,
    };
  }

  function startCrop() {
    zoomTo(null);
    setPicking(false);
    setCropping(true);
  }

  function stopCrop() {
    setCropping(false);
    setCropBox(undefined);
  }

  function saveCrop() {
    const shares = cropShares();
    if (!shares) return;
    stopCrop();
    void edit({ kind: "crop", ...shares }, "Cropped copy made beside it");
  }

  /** The crop's size in the picture's own pixels, as the box is drawn. */
  const cropPixels = () => {
    const shares = cropShares();
    const own = natural();
    return shares && own ? `${Math.round(shares.width * own[0]).toLocaleString()} × ${Math.round(shares.height * own[1]).toLocaleString()}` : "";
  };

  function onPointerDown(event: PointerEvent) {
    // A press on a control is its own: a drag held by the stage would take its click.
    if ((event.target as Element).closest("button, input, [role=toolbar]")) return;
    if (event.button === 0 && cropping()) return drawCrop(event);
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
    /** Mirrored, a turn right on screen is a turn left underneath. */
    turn: (by: number) => {
      // A crop is drawn over the picture as it stands, and can't be saved turned.
      stopCrop();
      setTurn(turn() + (flip() ? -by : by));
      zoomTo(null);
    },
    /** A mirror on screen, left to right, whichever way the picture stands now. */
    flip: () => {
      stopCrop();
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
  async function saveTurn() {
    kept = true;
    await work(async () => (kept = await props.tools!.run({ kind: "turn", quarters: quarters(), flip: flip() })), "Turn saved");
  }
  const turned = () => quarters() !== 0 || flip();
  const smaller = () => COPY_EDGES.filter((edge) => edge < Math.max(...(natural() ?? [0])));

  /** How many bytes each kind of copy takes per pixel, from a small copy of what shows. */
  async function guessRates() {
    if (rates() || !canvas.width) return;
    const sample = Math.min(1, GUESS_EDGE / Math.max(canvas.width, canvas.height));
    const [width, height] = [Math.max(1, Math.round(canvas.width * sample)), Math.max(1, Math.round(canvas.height * sample))];
    const board = new OffscreenCanvas(width, height);
    board.getContext("2d")!.drawImage(canvas, 0, 0, width, height);
    const rate = async (type: string, quality?: number) => (await board.convertToBlob({ type, quality })).size / (width * height);
    const [png, jpeg, share] = [await rate("image/png"), await rate("image/jpeg", QUALITY), await rate("image/jpeg", SHARE_QUALITY)];
    if (!gone) setRates({ png, jpeg, share });
  }

  /** About how big a copy comes out, `edge` long at most. TIFF and moving pictures go unguessed. */
  function guess(format: PictureFormat | "share", edge = Infinity) {
    const own = natural();
    const rate = rates();
    if (!own || !rate || frames()) return undefined;
    const shrink = Math.min(1, edge / Math.max(...own));
    const pixels = Math.round(own[0] * shrink) * Math.round(own[1] * shrink);
    const bytes = {
      png: rate.png * pixels,
      jpeg: rate.jpeg * pixels,
      share: rate.share * pixels,
      bmp: pixels * (look()?.clear ? 4 : 3) + BMP_HEADER,
      tiff: NaN,
    }[format];
    return Number.isFinite(bytes) ? `≈${formatSize(bytes)}` : undefined;
  }

  function toggleTools() {
    if (!toolsButton || !toolsPanel) return;
    if (toolsPanel.matches(":popover-open")) return toolsPanel.hidePopover();
    toolsPanel.showPopover();
    guessRates().catch(console.error);
    const { right, bottom } = toolsButton.getBoundingClientRect();
    const { width, height } = toolsPanel.getBoundingClientRect();
    toolsPanel.style.left = `${Math.max(4, right - width)}px`;
    toolsPanel.style.top = `${bottom + 6 + height > innerHeight ? Math.max(4, bottom - 34 - height) : bottom + 6}px`;
  }

  props.keys((event) => {
    const key = event.key.toLowerCase();
    if (event.ctrlKey && key === "c" && !getSelection()?.toString()) return copyPicture(), true;
    if (event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement && event.target.type !== "range") return false;
    if (cropping() && key === "enter") saveCrop();
    else if (cropping() && key === "escape") stopCrop();
    else if (key === "c" && props.tools && !turned() && !frames()) (cropping() ? stopCrop : startCrop)();
    else if (key === "+" || key === "=") tools.in();
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
    if (!kept && props.tools?.canSave && turned() && !frames()) props.tools.offerTurn?.({ kind: "turn", quarters: quarters(), flip: flip() });
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
      transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scaleX(${flip() ? -1 : 1}) rotate(${turn() * 90}deg) scale(${scale()})`,
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
      data-cropping={cropping() || undefined}
      style={{ "--picture-tint": look()?.tint ?? "transparent" }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onDblClick={(event) => !picking() && !cropping() && zoomTo(zoom() === null ? 1 : null, zoom() === null ? fromMiddle(event) : undefined)}
    >
      <canvas ref={canvas} class="preview-picture" style={style()} />
      <Show when={mapped()}>
        <Minimap
          source={() => canvas}
          aspect={() => shownSize().width / shownSize().height}
          turn={turn}
          flip={flip}
          view={() => viewWindow(box(), shownSize(), pan())}
          onMove={(center) => setPan(panFor(center, shownSize()))}
          live={frames() > 0}
        />
      </Show>
      <Show when={cropping() && cropBox()}>
        {(chosen) => (
          <div
            class="picture-crop"
            style={{ left: `${chosen().left}px`, top: `${chosen().top}px`, width: `${chosen().width}px`, height: `${chosen().height}px` }}
          >
            <Show when={cropPixels()}>
              <span class="picture-crop-size">{cropPixels()} px</span>
            </Show>
          </div>
        )}
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
        <Show when={cropping()}>
          <span class="zoom-chip picture-crop-hint">{cropShares() ? "Shift keeps it square" : "Drag over the part to keep"}</span>
          <button class="preview-chip" aria-keyshortcuts="Enter" disabled={!cropShares() || working()} onClick={saveCrop}>
            Save crop
          </button>
          <button class="preview-chip" aria-keyshortcuts="Escape" onClick={stopCrop}>
            Cancel
          </button>
        </Show>
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
                  <Show when={!frames()}>
                    <button
                      class="preview-chip"
                      disabled={turned()}
                      aria-describedby={turned() ? "picture-crop-why" : undefined}
                      onClick={() => (toolsPanel?.hidePopover(), startCrop())}
                    >
                      Crop <kbd>C</kbd>
                    </button>
                  </Show>
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
                          <Show when={guess(own().format ?? "png", edge)}>{(about) => <small class="chip-guess">{about()}</small>}</Show>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
                <p class="picture-tools-head">Copy as</p>
                <div class="picture-tools-row">
                  <For each={PICTURE_FORMATS.filter(([format]) => format !== own().format)}>
                    {([format, name]) => (
                      <button class="preview-chip" onClick={() => void edit({ kind: "convert", format }, `${name} copy made beside it`)}>
                        {name}
                        <Show when={guess(format)}>{(about) => <small class="chip-guess">{about()}</small>}</Show>
                      </button>
                    )}
                  </For>
                  <button class="preview-chip" onClick={() => void edit({ kind: "share" }, "Copy to share made beside it")}>
                    To share
                    <Show when={guess("share", SHARE_EDGE)}>{(about) => <small class="chip-guess">{about()}</small>}</Show>
                  </button>
                </div>
                <p class="cog-note">
                  A copy to share is a smaller JPEG with no place or camera in it. Copies go beside the picture, and sizes are a guess.
                  <Show when={turned() && !frames()}>
                    <span id="picture-crop-why"> Save the turn first to crop it.</span>
                  </Show>
                </p>
              </div>
            </>
          )}
        </Show>
        <ToolCog label="Picture settings" items={VIEWER_SETTINGS.Pictures} />
      </div>
    </div>
  );
}
