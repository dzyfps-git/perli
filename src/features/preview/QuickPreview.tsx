import { convertFileSrc } from "@tauri-apps/api/core";
import { createEffect, createResource, createSignal, For, lazy, on, onCleanup, onMount, Show } from "solid-js";
import {
  aiffAudio,
  archiveTest,
  archivePassword,
  archiveText,
  audioPeaks,
  besideText,
  bookChapter,
  dragEntry,
  fetchCover,
  fetchArchivePicture,
  fetchBigPicture,
  fetchPictureFile,
  fetchRows,
  fetchThumb,
  keepOnDevice,
  modelFile,
  openAudio,
  openLink,
  pictureSize,
  previewRow,
  rowProperties,
  saveFrame,
  songAudio,
  songInfo,
  startJob,
  type ArchiveEntry,
  type Preview,
  type Row,
  type Thumb,
} from "../../api";
import { formatSize } from "../../ui/format";
import { openSheet } from "../../ui/sheet";
import { typeText } from "../filelist/typeNames";
import type { FolderView } from "../navigation/folderView";
import { join, parentOf, resolveRelative } from "../navigation/path";
import { languageOf } from "./highlight";
import { tableDelimiter } from "./table";
import { neighbours, previewSize, setNeighbours, setPreviewSize } from "./viewerPrefs";
import type { TextPiece, TextViewProps } from "./TextView";
import type { BookViewProps } from "./DocView";
import type { ComicViewProps } from "./ComicView";
import type { ArchiveViewProps } from "./ArchiveView";
import type { PlayerProps } from "./Player";
import type { VideoViewProps } from "./VideoView";
import { song, wav, type Track } from "./nowPlaying";
import "./preview.css";

/** Which row the preview starts on. A reload while it is open moves it on to the new rows. */
export interface PreviewAt {
  view: number;
  snapshot: () => number;
  index: number;
  count: () => number;
  /** Where the list's selection is after a reload. The preview selects its row, so this is it. */
  selected: () => number | undefined;
  /** The folder shown, where rows with no location of their own are. */
  folder: string;
}

/** Pictures in Markdown don't need the full size. */
const MARKDOWN_PICTURE_EDGE = 1200;
const SLIDE_PX = 24;
const SLIDE_MS = 180;
/** How long the pointer and the keys rest before a viewer's tools step back. */
const IDLE_MS = 2500;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
// Both come with the first file that needs them.
const ModelStage = lazy(() => import("./ModelStage").then((module) => ({ default: module.ModelStage })));
const Player = lazy(() => import("./Player").then((module) => ({ default: module.Player })));
const TextView = lazy(() => import("./TextView").then((module) => ({ default: module.TextView })));
const MarkdownView = lazy(() => import("./DocView").then((module) => ({ default: module.MarkdownView })));
const BookView = lazy(() => import("./DocView").then((module) => ({ default: module.BookView })));
const ArchiveView = lazy(() => import("./ArchiveView").then((module) => ({ default: module.ArchiveView })));
const ComicView = lazy(() => import("./ComicView").then((module) => ({ default: module.ComicView })));
const PictureView = lazy(() => import("./PictureView").then((module) => ({ default: module.PictureView })));
const VideoView = lazy(() => import("./VideoView").then((module) => ({ default: module.VideoView })));

/** Files the player plays, for Play next to skip to. */
const AUDIO = /\.(mid|midi|mp3|m4a|aac|wav|flac|ogg|oga|opus|weba|aiff?|aifc)$/i;
const PICTURES = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif|avif|ico|jxl|svg)$/i;
/** Pictures that can move, and what the window calls them. */
const MOVING: Record<string, string> = { gif: "image/gif", webp: "image/webp", apng: "image/apng", png: "image/png" };
/** A picture is read whole to learn whether it moves, so a bigger one is shown still. */
const MOST_MOVING = 64 * 1024 * 1024;
/** How long the slideshow stays on a picture. */
const SLIDE_SHOW_MS = 4000;
/** Sound the window cannot play, which Rust hands over as a WAV. */
const AIFF = /\.(aiff?|aifc)$/i;
const SOUND_SETS = /\.sf2$/i;
const COMICS = /\.cbz$/i;
/** The queue is the songs among this many rows of the folder. */
const MOST_QUEUE = 5000;
const QUEUE_BATCH = 500;
/** Arrow keys held down skip past rows, so a row has to stay selected this long first. */
const SETTLE_MS = 120;
const ICON_DOCK = "\uE90D";
const ICON_CLOSE = "\uE711";
const ICON_FULL = "\uE740";
const ICON_WINDOWED = "\uE73F";
const ICON_STRIP = "\uE8FD";
const ICON_CLOUD = "\uE753";
/** How often a file the sync app is fetching is looked at, and for how long at most. */
const FETCH_POLL_MS = 1000;
const FETCH_TRIES = 300;
/** How many files the strip shows on each side of the one in the preview. */
const BESIDE = 5;
/** A size the preview is never saved smaller than, so a slip of the hand can't lose it. */
const LEAST_SIZE = 320;
const SAVE_SIZE_MS = 300;
const NEXT_BATCH = 50;
const dates = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function draw(canvas: HTMLCanvasElement, picture: Thumb) {
  canvas.width = picture.width;
  canvas.height = picture.height;
  canvas.getContext("2d")!.putImageData(new ImageData(picture.pixels, picture.width, picture.height), 0, 0);
}

/**
 * A look at one file at a time over the list, the way Space works in other file managers. The
 * arrow keys step through the rows and move the list's selection along, so closing leaves the
 * last one looked at selected.
 */
export function QuickPreview(props: {
  at: PreviewAt;
  onStep: (index: number) => void;
  onOpen: (row: Row) => void;
  onClose: () => void;
  /** Beside the list instead of over it. The list keeps the keys, and `onClose` puts the pane away. */
  docked?: boolean;
  /** Moves the preview beside the list. */
  onDock?: () => void;
  /** Lets the user choose an app for the file. */
  onOpenWith?: (path: string) => void;
  /** Shows the file in its own folder, for a file found further down. */
  onShow?: (path: string) => void;
}) {
  const [index, setIndex] = createSignal(props.at.index);
  const [row, setRow] = createSignal<Row>();
  const [shown, setShown] = createSignal<Preview>();
  const [failure, setFailure] = createSignal<string>();
  /** What the view shown adds to the footer, such as a picture's size. */
  const [note, setNote] = createSignal<string>();
  /** The preview fills the window. */
  const [full, setFull] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  /** The slideshow goes from picture to picture, so it lives here and not in one of them. */
  const [slideshow, setSlideshow] = createSignal(false);
  /** The sync app is fetching the file shown, so it can be previewed. */
  const [fetching, setFetching] = createSignal(false);
  let dialog!: HTMLDialogElement;
  /** Sends the sheet back to the row it grew from. Only the preview over the list has it. */
  let fold: ((after?: () => void) => void) | undefined;
  const shut = (after?: () => void) => (fold ? fold(after) : (props.onClose(), after?.()));
  let body!: HTMLDivElement;
  /** Which way the last step went, for the slide. */
  let stepped = 0;
  /** The snapshot the row shown came from, so its later pieces are of the same file. */
  let snapshot = 0;
  /** Bumped by each step, so answers for a row already left behind are dropped. */
  let ticket = 0;
  /** The keys the view shown takes first, such as the player's or the model's. */
  let viewKeys: ((event: KeyboardEvent) => boolean) | undefined;

  const folderOf = (item: Row) => item.location || props.at.folder;
  const pathOf = (item: Row) => join(folderOf(item), item.name);
  async function show(at: number) {
    const mine = ++ticket;
    setFailure(undefined);
    setFetching(false);
    const { view } = props.at;
    snapshot = props.at.snapshot();
    try {
      const [found] = await fetchRows(view, snapshot, at, 1);
      if (mine !== ticket) return;
      setRow(found);
      setShown(undefined);
      if (!found) return;
      const preview = await previewRow(view, snapshot, at);
      if (mine !== ticket) return;
      setShown(preview);
      slideIn();
    } catch (reason) {
      if (mine === ticket) setFailure(String(reason));
    }
  }

  /**
   * Asks the sync app to keep the file on this PC, then shows its real preview once it is here.
   * Nothing downloads until this is asked for.
   */
  async function fetchShown() {
    const { view } = props.at;
    const [at, shot, mine] = [index(), snapshot, ticket];
    setFetching(true);
    try {
      await keepOnDevice({ view, request: shot, rows: [at] }, true);
      for (let tries = 0; tries < FETCH_TRIES && mine === ticket; tries++) {
        if ((await previewRow(view, shot, at)).kind !== "cloud") return void (mine === ticket && show(at));
        await new Promise((done) => setTimeout(done, FETCH_POLL_MS));
      }
      if (mine === ticket) setFailure("It is still downloading. Try again in a moment.");
    } catch (reason) {
      if (mine === ticket) setFailure(String(reason));
    } finally {
      if (mine === ticket) setFetching(false);
    }
  }

  function text(item: Row, first: TextPiece): TextViewProps {
    const { view } = props.at;
    const at = index();
    const shot = snapshot;
    return {
      first,
      more: async (offset) => {
        const piece = await previewRow(view, shot, at, offset);
        return piece.kind === "text" ? piece : null;
      },
      language: languageOf(item.name),
      table: tableDelimiter(item.name),
      keys: (handler) => (viewKeys = handler),
      onFailure: setFailure,
    };
  }

  function picture(item: Row) {
    const { view } = props.at;
    const at = index();
    const shot = snapshot;
    const moving = MOVING[item.name.split(".").pop()!.toLowerCase()];
    return {
      // Reading the file would download one that is only online.
      bytes: moving && !item.isCloud && !item.isDir && item.size <= MOST_MOVING ? () => modelFile(view, shot, at) : undefined,
      moving,
      facts: item.isDir || item.isCloud ? undefined : () => rowProperties(view, shot, at),
      slideshow: props.docked ? undefined : slideshow,
      onSlideshow: props.docked ? undefined : setSlideshow,
      load: (edge: number) => fetchBigPicture(view, shot, at, edge),
      size: () => pictureSize(view, shot, at),
      keys: (handler: typeof viewKeys) => (viewKeys = handler),
      note: setNote,
    };
  }

  /** Fills each picture placeholder in `root` with what `load` gives for its name. */
  function fillPictures(root: HTMLElement, load: (name: string) => Promise<Thumb | null>) {
    for (const canvas of root.querySelectorAll<HTMLCanvasElement>("canvas[data-picture]")) {
      // Nothing takes room until the picture is drawn, and a missing one says so.
      canvas.width = canvas.height = 0;
      const missing = () => {
        const note = document.createElement("span");
        note.className = "md-blocked";
        note.textContent = canvas.getAttribute("aria-label") || "Missing picture";
        canvas.replaceWith(note);
      };
      load(canvas.dataset.picture!)
        .then((picture) => (picture ? draw(canvas, picture) : missing()))
        .catch(missing);
    }
  }

  /** Pictures beside the file draw from this PC, and links go to the browser, never in here. */
  function markdown(item: Row, html: string, source: string) {
    return {
      html,
      source,
      fill: (article: HTMLElement) =>
        fillPictures(article, (name) => fetchPictureFile(resolveRelative(folderOf(item), name), MARKDOWN_PICTURE_EDGE)),
      keys: (handler: typeof viewKeys) => (viewKeys = handler),
    };
  }

  function book(item: Row, preview: Extract<Preview, { kind: "book" }>): BookViewProps {
    const { view } = props.at;
    const at = index();
    const shot = snapshot;
    return {
      path: pathOf(item),
      title: preview.title,
      chapters: preview.chapters,
      contents: preview.contents,
      load: (chapter) => bookChapter(view, shot, at, chapter),
      fill: (article) => fillPictures(article, (name) => fetchArchivePicture(view, shot, at, name, MARKDOWN_PICTURE_EDGE)),
      keys: (handler) => (viewKeys = handler),
      note: setNote,
      onFailure: setFailure,
    };
  }

  /** Play next: on to the next sound file in the list, if there is one. */
  const nextAudio = () => nextOf(AUDIO);

  /** On to the next file further down whose name fits `kind`. False when there is none. */
  async function nextOf(kind: RegExp) {
    const mine = ticket;
    for (let at = index() + 1; at < props.at.count(); at += NEXT_BATCH) {
      const rows = await fetchRows(props.at.view, snapshot, at, NEXT_BATCH);
      if (mine !== ticket) return;
      const found = rows.findIndex((item) => !item.isDir && kind.test(item.name));
      if (found >= 0) return step(at + found - index()), true;
      if (!rows.length) break;
    }
    return false;
  }

  // The slideshow moves on after each picture has had its time, and stops after the last.
  createEffect(() => {
    if (!slideshow() || shown()?.kind !== "picture") return;
    const timer = window.setTimeout(() => void nextOf(PICTURES).then((went) => went || setSlideshow(false)), SLIDE_SHOW_MS);
    onCleanup(() => window.clearTimeout(timer));
  });

  const reader = (at: number, shot: number) => (part?: string) => modelFile(props.at.view, shot, at, part);

  /** The songs of the folder, in list order, and the sound sets there for MIDI files. */
  async function folderSongs(view: number, shot: number) {
    const tracks: Track[] = [];
    const fonts: string[] = [];
    const count = Math.min(props.at.count(), MOST_QUEUE);
    for (let at = 0; at < count; at += QUEUE_BATCH) {
      const rows = await fetchRows(view, shot, at, Math.min(QUEUE_BATCH, count - at));
      rows.forEach((item, offset) => {
        if (item.isDir) return;
        if (AUDIO.test(item.name)) tracks.push({ path: pathOf(item), name: item.name, index: at + offset });
        else if (SOUND_SETS.test(item.name)) fonts.push(pathOf(item));
      });
      if (!rows.length) break;
    }
    return { tracks, fonts };
  }

  function player(item: Row, midi: boolean): PlayerProps {
    const { view } = props.at;
    const at = index();
    const shot = snapshot;
    return {
      path: pathOf(item),
      name: item.name,
      size: item.size,
      load: AIFF.test(item.name)
        ? async () => wav(await aiffAudio(view, shot, at))
        : async () => {
            const [path, tags] = await openAudio(view, shot, at);
            return { url: convertFileSrc(path), made: false, tags };
          },
      render: midi ? async (playing, font) => song(await songAudio(view, shot, at, { playing, font })) : undefined,
      info: midi ? () => songInfo(view, shot, at) : undefined,
      cover: midi ? undefined : (edge) => fetchCover(view, shot, at, edge),
      lyrics: midi || item.isCloud ? undefined : () => besideText(view, shot, at, "lrc"),
      peaks: midi || item.isCloud ? undefined : (bars) => audioPeaks(view, shot, at, bars),
      queue: () => folderSongs(view, shot),
      onPick: (target) => step(target - index()),
      keys: (handler) => (viewKeys = handler),
      tint: (color) => body.style.setProperty("--player-tint", color ?? "transparent"),
      onNext: () => void nextAudio(),
    };
  }

  function video(item: Row): VideoViewProps {
    const { view } = props.at;
    const at = index();
    const shot = snapshot;
    return {
      path: pathOf(item),
      load: async () => convertFileSrc((await openAudio(view, shot, at))[0]),
      subtitles: async () => (item.isCloud ? null : (await besideText(view, shot, at, "srt")) ?? (await besideText(view, shot, at, "vtt"))),
      saveFrame: (seconds, png) => saveFrame(view, shot, at, seconds, png),
      keys: (handler) => (viewKeys = handler),
      note: setNote,
    };
  }

  function archive(entries: ArchiveEntry[], more: boolean): ArchiveViewProps {
    const { view } = props.at;
    const at = index();
    const shot = snapshot;
    return {
      entries,
      more,
      picture: (entry, edge, password) => fetchArchivePicture(view, shot, at, entry, edge, password),
      text: (entry, password) => archiveText(view, shot, at, entry, password),
      check: (entry, password) => archivePassword(view, shot, at, entry, password),
      extract: (only, password) =>
        startJob({ kind: "unzip", selection: { view, request: shot, rows: [at] }, ownFolder: false, only, password }, view).catch(
          (reason) => void setFailure(String(reason)),
        ),
      test: (password) => archiveTest(view, shot, at, password),
      drag: (entry, password) => dragEntry(view, shot, at, entry, password),
      keys: (handler) => (viewKeys = handler),
    };
  }

  function comic(item: Row, pages: string[]): ComicViewProps {
    const { view } = props.at;
    const at = index();
    const shot = snapshot;
    return {
      path: pathOf(item),
      pages,
      load: (page, edge) => fetchArchivePicture(view, shot, at, page, edge),
      keys: (handler) => (viewKeys = handler),
      note: setNote,
      onNextVolume: () => nextOf(COMICS),
    };
  }

  function onBodyClick(event: MouseEvent) {
    const link = (event.target as HTMLElement).closest("a");
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute("href");
    if (href) openLink(href).catch((reason) => setFailure(String(reason)));
  }

  /** The body itself moves, so the slide never makes the text scroll sideways. */
  function slideIn() {
    if (!stepped || reducedMotion.matches) return;
    body.animate(
      { translate: [`${stepped * SLIDE_PX}px 0`, "0 0"], opacity: [0, 1] },
      { duration: SLIDE_MS, easing: "cubic-bezier(0.3, 1.1, 0.5, 1)" },
    );
    stepped = 0;
  }

  function step(by: number) {
    const target = index() + by;
    if (target < 0 || target >= props.at.count()) return;
    stepped = by;
    setIndex(target);
    props.onStep(target);
  }

  function onKeyDown(event: KeyboardEvent) {
    stir();
    const key = event.key;
    const target = event.target as HTMLElement;
    // A slider takes its own arrow keys.
    if (key.startsWith("Arrow") && target.matches("input")) return;
    // Enter and Space press a focused button, such as Open with or Copy path.
    if ((key === "Enter" || key === " ") && target.closest("button, summary, a[href]")) return;
    if (viewKeys?.(event)) {
      event.preventDefault();
      return;
    }
    // Typing in a view's box, such as Find, is left alone. Beside the list, the list has the rest.
    if (props.docked || target.matches("input:not([type=range]), textarea")) return;
    if (key === "ArrowLeft" || key === "ArrowUp") step(-1);
    else if (key === "ArrowRight" || key === "ArrowDown") step(1);
    else if (key === " ") {
      if (!event.repeat) shut();
    } else if (key === "Enter" && row()) {
      props.onOpen(row()!);
      props.onClose();
    } else if (key === "F11" || (key.toLowerCase() === "f" && !event.ctrlKey && !event.altKey)) setFull(!full());
    else return;
    event.preventDefault();
  }

  let idleTimer: number | undefined;
  /** The pointer or a key moved, so the tools come back and the wait starts again. */
  function stir() {
    body.removeAttribute("data-idle");
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => body.setAttribute("data-idle", ""), IDLE_MS);
  }

  onMount(() => {
    // Not `show()`: that moves focus into the dialog, and the list must keep the keys.
    if (props.docked) dialog.open = true;
    else {
      fold = openSheet(dialog);
      body.focus();
      // Dragging the corner sizes the preview, and the next one opens at that size.
      let timer: number | undefined;
      const watch = new ResizeObserver(() => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          const { width, height } = dialog.getBoundingClientRect();
          if (full() || !dialog.open || width < LEAST_SIZE || height < LEAST_SIZE) return;
          if (dialog.style.width || dialog.style.height) setPreviewSize({ width: Math.round(width), height: Math.round(height) });
        }, SAVE_SIZE_MS);
      });
      watch.observe(dialog);
      onCleanup(() => {
        watch.disconnect();
        window.clearTimeout(timer);
      });
    }
    stir();
  });
  onCleanup(() => window.clearTimeout(idleTimer));

  // A reload of the folder replaces the snapshot, so the row is fetched again from the new one.
  let shot = props.at.snapshot();
  createEffect(
    on([index, props.at.snapshot], ([at, now]) => {
      // The same file after a reload, even when rows above it came or went.
      const moved = now !== shot ? props.at.selected() : undefined;
      shot = now;
      if (moved !== undefined && moved !== at) return void setIndex(moved);
      const kept = Math.max(0, Math.min(at, props.at.count() - 1));
      if (kept !== at) setIndex(kept);
      else void show(at);
    }),
  );

  const facts = () => {
    const item = row();
    if (!item) return [];
    return [
      typeText(item.name, item.isDir),
      item.isDir && !item.size ? "" : formatSize(item.size),
      item.modified > 0 ? dates.format(item.modified) : "",
      `${index() + 1} of ${props.at.count().toLocaleString()}`,
    ].filter(Boolean);
  };

  async function copyPath() {
    await navigator.clipboard.writeText(pathOf(row()!));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  // The size it was last dragged to. The browser writes its own while the corner is dragged.
  const size = props.docked ? null : previewSize();

  return (
    <dialog
      ref={dialog}
      class="quick-preview"
      classList={{ "preview-docked": props.docked, "preview-full": full() }}
      style={size ? { width: `${size.width}px`, height: `${size.height}px` } : undefined}
      // A click on something that takes no focus would leave the keys with nothing to go to.
      onFocusOut={(event) => !props.docked && !event.relatedTarget && body.focus()}
      aria-label={row() ? `Preview of ${row()!.name}` : "Preview"}
      onKeyDown={onKeyDown}
      onPointerMove={stir}
      onPointerDown={stir}
      onClose={props.onClose}
      onClick={(event) => event.target === dialog && !props.docked && shut()}
    >
      <div
        ref={body}
        class="preview-body"
        tabindex="0"
        onClick={onBodyClick}
      >
        <Show when={shown()} keyed>
          {(preview) => (
            <>
              {preview.kind === "text" && <TextView {...text(row()!, preview)} />}
              {preview.kind === "markdown" && <MarkdownView {...markdown(row()!, preview.html, preview.source)} />}
              {preview.kind === "picture" && <PictureView {...picture(row()!)} />}
              {preview.kind === "cloud" && (
                <>
                  <PictureView {...picture(row()!)} />
                  <div class="preview-cloud" role="status">
                    <span class="preview-cloud-icon" aria-hidden="true">
                      {ICON_CLOUD}
                    </span>
                    <span>Only online · {formatSize(row()!.size)}</span>
                    <button class="preview-chip" disabled={fetching()} onClick={() => void fetchShown()}>
                      {fetching() ? "Downloading…" : "Download to preview"}
                    </button>
                  </div>
                </>
              )}
              {preview.kind === "comic" && <ComicView {...comic(row()!, preview.pages)} />}
              {preview.kind === "book" && <BookView {...book(row()!, preview)} />}
              {preview.kind === "archive" && <ArchiveView {...archive(preview.entries, preview.more)} />}
              {preview.kind === "model" && (
                <ModelStage
                  name={row()!.name}
                  read={reader(index(), snapshot)}
                  keys={(handler) => (viewKeys = handler)}
                  onFailure={setFailure}
                />
              )}
              {(preview.kind === "song" || preview.kind === "audio") && (
                <Player {...player(row()!, preview.kind === "song")} />
              )}
              {preview.kind === "video" && <VideoView {...video(row()!)} />}
            </>
          )}
        </Show>
        <Show when={failure()}>
          <p class="preview-note" role="alert">
            {failure()}
          </p>
        </Show>
      </div>
      <Show when={!props.docked && neighbours() && row()}>
        <Neighbours at={props.at} index={index()} onPick={(at) => step(at - index())} />
      </Show>
      <footer class="preview-footer">
        <span class="preview-name">{row()?.name}</span>
        <span class="preview-facts">{facts().join("  ·  ")}</span>
        <Show when={note()}>
          <span class="preview-facts preview-page">{note()}</span>
        </Show>
        <Show when={row() && parentOf(pathOf(row()!)) !== props.at.folder && row()!.location}>
          <span class="preview-facts">{row()!.location}</span>
        </Show>
        <Show when={row() && !row()!.isDir}>
          <span class="preview-chips">
            <button class="preview-chip" onClick={() => (props.onOpen(row()!), props.onClose())}>
              Open
            </button>
            <Show when={props.onOpenWith}>
              <button class="preview-chip" onClick={() => shut(() => props.onOpenWith!(pathOf(row()!)))}>
                Open with
              </button>
            </Show>
            <Show when={props.onShow && row()!.location}>
              <button class="preview-chip" onClick={() => shut(() => props.onShow!(pathOf(row()!)))}>
                Show in folder
              </button>
            </Show>
            <button class="preview-chip" aria-live="polite" onClick={() => void copyPath().catch((reason) => setFailure(String(reason)))}>
              {copied() ? "Copied" : "Copy path"}
            </button>
          </span>
        </Show>
        <Show when={!props.docked}>
          <button
            class="preview-dock-button preview-first-button"
            aria-label="Neighbouring files"
            aria-pressed={neighbours()}
            onClick={() => setNeighbours(!neighbours())}
          >
            {ICON_STRIP}
          </button>
          <button
            class="preview-dock-button"
            aria-label={full() ? "Back to a window" : "Fill the window"}
            aria-keyshortcuts="F"
            aria-pressed={full()}
            onClick={() => setFull(!full())}
          >
            {full() ? ICON_WINDOWED : ICON_FULL}
          </button>
        </Show>
        <Show when={props.docked || props.onDock}>
          <button
            class="preview-dock-button"
            aria-label={props.docked ? "Close preview pane" : "Keep beside the list"}
            onClick={() => (props.docked ? props.onClose() : props.onDock!())}
          >
            {props.docked ? ICON_CLOSE : ICON_DOCK}
          </button>
        </Show>
      </footer>
    </dialog>
  );
}

/** The files on each side of the one shown, as small pictures to step to. */
function Neighbours(props: { at: PreviewAt; index: number; onPick: (index: number) => void }) {
  const first = () => Math.max(0, props.index - BESIDE);
  const [rows] = createResource(
    () => [first(), props.at.snapshot()] as const,
    ([start, shot]) =>
      fetchRows(props.at.view, shot, start, Math.min(props.at.count(), props.index + BESIDE + 1) - start).then((list) =>
        list.map((row, at) => ({ row, index: start + at, shot })),
      ),
  );
  /** Only a picture shows as itself. Windows' icon for the rest would not look like Perli. */
  function fill(canvas: HTMLCanvasElement, name: string, index: number, shot: number) {
    if (!PICTURES.test(name)) return;
    fetchThumb(props.at.view, shot, index)
      .then((thumb) => thumb && canvas.isConnected && (draw(canvas, thumb), canvas.removeAttribute("hidden")))
      .catch(() => undefined);
  }
  return (
    <nav class="preview-strip" aria-label="Neighbouring files">
      <For each={rows.latest ?? []}>
        {(item) => (
          <button
            class="preview-strip-item"
            aria-label={item.row.name}
            aria-current={item.index === props.index ? "true" : undefined}
            tabindex="-1"
            onClick={() => props.onPick(item.index)}
          >
            <span class="preview-strip-kind">{item.row.isDir ? "folder" : item.row.name.split(".").pop()!.slice(0, 5)}</span>
            <canvas hidden ref={(canvas) => fill(canvas, item.row.name, item.index, item.shot)} />
          </button>
        )}
      </For>
    </nav>
  );
}

/** The preview kept beside the list, showing the one row selected there. */
export function PreviewDock(props: { view: FolderView; onOpen: (row: Row) => void; onClose: () => void }) {
  const [at, setAt] = createSignal<PreviewAt>();
  let timer: number | undefined;
  createEffect(
    on(
      () => props.view.cursor(),
      (cursor) => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          const folder = props.view.folder();
          setAt(
            cursor && folder
              ? {
                  view: props.view.id,
                  snapshot: () => cursor.snapshot,
                  index: cursor.index,
                  count: () => folder.count,
                  selected: () => cursor.index,
                  folder: folder.path,
                }
              : undefined,
          );
        }, SETTLE_MS);
      },
    ),
  );
  onCleanup(() => window.clearTimeout(timer));

  return (
    <aside class="preview-dock" aria-label="Preview">
      <Show
        when={at()}
        keyed
        fallback={
          <p class="details-empty">
            Select one item to preview it.
            <button class="preview-dock-button" aria-label="Close preview pane" onClick={props.onClose}>
              {ICON_CLOSE}
            </button>
          </p>
        }
      >
        {(now) => <QuickPreview at={now} docked onStep={() => undefined} onOpen={props.onOpen} onClose={props.onClose} />}
      </Show>
    </aside>
  );
}
