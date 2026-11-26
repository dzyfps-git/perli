import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { onPreviewerKey, previewerClose, previewerOpen, previewerPlace, previewerSnapshot, type PreviewerPlace } from "../../api";
import { colorRef, overlaps } from "./office";
import { draw } from "./QuickPreview";

/** Things of Perli's that float over the page. One over the previewer hides it for a moment. */
const FLOATING = ":popover-open, dialog:modal, .menu, .hover-card, .tab-peek, .recent-flyout";
/** Points across the previewer checked for anything else drawn over it. */
const SAMPLES = 5;
/** How long a previewer may take before Perli says it is waiting on it. */
const SLOW_MS = 2500;

let tickets = 0;

/**
 * Windows' own previewer for a row, such as Office's, drawn by Windows over this box. The box
 * follows the page each frame. While a menu, a tooltip or a sheet of Perli's covers it, a
 * picture of it stands in, since Windows' window would hide anything of the page above it.
 */
export function HostedPreview(props: {
  view: number;
  request: number;
  row: number;
  /** It failed, or took too long: the page shows Perli's own reader instead. */
  onFailure: (reason: string) => void;
  /** Esc was pressed inside it. */
  onEscape: () => void;
}) {
  let box!: HTMLDivElement;
  let still!: HTMLCanvasElement;
  const ticket = ++tickets;
  const [ready, setReady] = createSignal(false);
  const [slow, setSlow] = createSignal(false);
  const [covered, setCovered] = createSignal(false);
  let frame = 0;
  let gone = false;
  let last = "";

  /** The box in physical pixels of the window. */
  function placeOf(): PreviewerPlace {
    const rect = box.getBoundingClientRect();
    const scale = devicePixelRatio;
    return {
      x: Math.round(rect.left * scale),
      y: Math.round(rect.top * scale),
      width: Math.max(1, Math.round(rect.width * scale)),
      height: Math.max(1, Math.round(rect.height * scale)),
    };
  }

  /** Whether anything of Perli's is drawn over the box, or the box is out of sight. */
  function isCovered() {
    const rect = box.getBoundingClientRect();
    if (document.hidden || !box.isConnected || rect.width < 2 || rect.height < 2 || !box.checkVisibility()) return true;
    for (const floating of document.querySelectorAll(FLOATING)) {
      if (floating.contains(box) || floating === box) continue;
      if (overlaps(floating.getBoundingClientRect(), rect)) return true;
    }
    for (let across = 0; across < SAMPLES; across++) {
      for (let down = 0; down < SAMPLES; down++) {
        const x = rect.left + ((across + 0.5) * rect.width) / SAMPLES;
        const y = rect.top + ((down + 0.5) * rect.height) / SAMPLES;
        const top = document.elementFromPoint(x, y);
        if (top && top !== box && !box.contains(top) && top !== still) return true;
      }
    }
    return false;
  }

  /** Counts each time the cover comes or goes, so a snapshot that ends late knows it is stale. */
  let turn = 0;

  /** Reads Windows' window from the screen while it is still there, then hides it, unless the
   *  cover went away while the picture was being read. */
  async function cover(mine: number) {
    const picture = await previewerSnapshot().catch(() => null);
    if (gone || mine !== turn) return;
    if (picture) draw(still, picture);
    setCovered(true);
    await previewerPlace(placeOf(), false).catch(console.error);
  }

  function follow() {
    if (gone) return;
    frame = requestAnimationFrame(follow);
    if (!ready()) return;
    const place = placeOf();
    const hidden = isCovered();
    const key = `${place.x},${place.y},${place.width},${place.height},${hidden}`;
    if (key === last) return;
    const wasHidden = last.endsWith("true");
    last = key;
    if (hidden !== wasHidden) turn++;
    if (hidden && !wasHidden) void cover(turn);
    else {
      void previewerPlace(place, !hidden).catch(console.error);
      if (!hidden && wasHidden) setCovered(false);
    }
  }

  onMount(() => {
    const style = getComputedStyle(box);
    const timer = window.setTimeout(() => setSlow(true), SLOW_MS);
    previewerOpen(props.view, props.request, props.row, placeOf(), colorRef(style.backgroundColor), colorRef(style.color), ticket)
      .then(() => {
        if (gone) return;
        setReady(true);
        last = "";
      })
      .catch((reason) => !gone && props.onFailure(String(reason)))
      .finally(() => {
        window.clearTimeout(timer);
        setSlow(false);
      });
    frame = requestAnimationFrame(follow);
    const unlisten = onPreviewerKey((key) => key === "Escape" && !gone && props.onEscape());
    onCleanup(() => {
      gone = true;
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      void previewerClose(ticket).catch(console.error);
      void unlisten.then((stop) => stop());
    });
  });

  return (
    <div ref={box} class="hosted-preview" data-ready={ready() || undefined}>
      <canvas ref={still} class="hosted-still" hidden={!covered()} aria-hidden="true" />
      <Show when={!ready()}>
        <p class="hosted-wait" role="status">
          {slow() ? "Office is taking a while…" : ""}
        </p>
      </Show>
    </div>
  );
}
