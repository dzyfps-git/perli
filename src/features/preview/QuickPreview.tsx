import { convertFileSrc } from "@tauri-apps/api/core";
import { createEffect, createSignal, lazy, on, onCleanup, onMount, Show } from "solid-js";
import {
  archiveText,
  bookChapter,
  fetchCover,
  fetchArchivePicture,
  fetchBigPicture,
  fetchPictureFile,
  fetchRows,
  modelFile,
  openAudio,
  openLink,
  pictureSize,
  previewRow,
  songAudio,
  songInfo,
  startJob,
  type ArchiveEntry,
  type Preview,
  type Row,
  type Thumb,
} from "../../api";
import { formatSize } from "../../ui/format";
import { typeText } from "../filelist/typeNames";
import { join, parentOf, resolveRelative } from "../navigation/path";
import { languageOf } from "./highlight";
import { tableDelimiter } from "./table";
import type { TextPiece, TextViewProps } from "./TextView";
import type { BookViewProps } from "./DocView";
import type { ComicViewProps } from "./ComicView";
import type { ArchiveViewProps } from "./ArchiveView";
import type { PlayerProps } from "./Player";
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

/** Files the player plays, for Play next to skip to. */
const AUDIO = /\.(mid|midi|mp3|m4a|aac|wav|flac|ogg|oga|opus|weba)$/i;
const NEXT_BATCH = 50;
const NO_TAGS = { title: null, artist: null, album: null };
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
}) {
  const [index, setIndex] = createSignal(props.at.index);
  const [row, setRow] = createSignal<Row>();
  const [shown, setShown] = createSignal<Preview>();
  const [failure, setFailure] = createSignal<string>();
  /** What the view shown adds to the footer, such as a picture's size. */
  const [note, setNote] = createSignal<string>();
  let dialog!: HTMLDialogElement;
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

  function picture() {
    const { view } = props.at;
    const at = index();
    const shot = snapshot;
    return {
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
  function markdown(item: Row, html: string) {
    return {
      html,
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
  async function nextAudio() {
    const mine = ticket;
    for (let at = index() + 1; at < props.at.count(); at += NEXT_BATCH) {
      const rows = await fetchRows(props.at.view, snapshot, at, NEXT_BATCH);
      if (mine !== ticket) return;
      const found = rows.findIndex((item) => !item.isDir && AUDIO.test(item.name));
      if (found >= 0) return step(at + found - index());
      if (!rows.length) return;
    }
  }

  const reader = (at: number, shot: number) => (part?: string) => modelFile(props.at.view, shot, at, part);

  function player(item: Row, midi: boolean): PlayerProps {
    const { view } = props.at;
    const at = index();
    const shot = snapshot;
    return {
      path: pathOf(item),
      name: item.name,
      size: item.size,
      load: midi
        ? async () => {
            const wav = await songAudio(view, shot, at);
            return { url: URL.createObjectURL(new Blob([wav], { type: "audio/wav" })), made: true, tags: NO_TAGS };
          }
        : async () => {
            const [path, tags] = await openAudio(view, shot, at);
            return { url: convertFileSrc(path), made: false, tags };
          },
      info: midi ? () => songInfo(view, shot, at) : undefined,
      cover: midi ? undefined : (edge) => fetchCover(view, shot, at, edge),
      keys: (handler) => (viewKeys = handler),
      tint: (color) => body.style.setProperty("--player-tint", color ?? "transparent"),
      onNext: () => void nextAudio(),
    };
  }

  function archive(entries: ArchiveEntry[], more: boolean): ArchiveViewProps {
    const { view } = props.at;
    const at = index();
    const shot = snapshot;
    return {
      entries,
      more,
      picture: (entry, edge) => fetchArchivePicture(view, shot, at, entry, edge),
      text: (entry) => archiveText(view, shot, at, entry),
      extract: (only) =>
        startJob({ kind: "unzip", selection: { view, request: shot, rows: [at] }, ownFolder: false, only }, view).catch(
          (reason) => void setFailure(String(reason)),
        ),
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
    if (viewKeys?.(event)) {
      event.preventDefault();
      return;
    }
    // Typing in a view's box, such as Find, is left alone.
    if (target.matches("input:not([type=range]), textarea")) return;
    if (key === "ArrowLeft" || key === "ArrowUp") step(-1);
    else if (key === "ArrowRight" || key === "ArrowDown") step(1);
    else if (key === " ") {
      if (!event.repeat) props.onClose();
    } else if (key === "Enter" && row()) {
      props.onOpen(row()!);
      props.onClose();
    } else return;
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
    dialog.showModal();
    body.focus();
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

  return (
    <dialog
      ref={dialog}
      class="quick-preview"
      aria-label={row() ? `Preview of ${row()!.name}` : "Preview"}
      onKeyDown={onKeyDown}
      onPointerMove={stir}
      onPointerDown={stir}
      onClose={props.onClose}
      onClick={(event) => event.target === dialog && props.onClose()}
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
              {preview.kind === "markdown" && <MarkdownView {...markdown(row()!, preview.html)} />}
              {preview.kind === "picture" && <PictureView {...picture()} />}
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
            </>
          )}
        </Show>
        <Show when={failure()}>
          <p class="preview-note" role="alert">
            {failure()}
          </p>
        </Show>
      </div>
      <footer class="preview-footer">
        <span class="preview-name">{row()?.name}</span>
        <span class="preview-facts">{facts().join("  ·  ")}</span>
        <Show when={note()}>
          <span class="preview-facts preview-page">{note()}</span>
        </Show>
        <Show when={row() && parentOf(pathOf(row()!)) !== props.at.folder && row()!.location}>
          <span class="preview-facts">{row()!.location}</span>
        </Show>
      </footer>
    </dialog>
  );
}
