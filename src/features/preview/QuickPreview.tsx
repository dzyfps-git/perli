import { createEffect, createSignal, on, onMount, Show } from "solid-js";
import {
  fetchBigPicture,
  fetchPictureFile,
  fetchRows,
  openLink,
  previewRow,
  type Preview,
  type Row,
  type Thumb,
} from "../../api";
import { formatSize } from "../../ui/format";
import { typeText } from "../filelist/typeNames";
import { join, parentOf, resolveRelative } from "../navigation/path";
import { highlight, languageOf } from "./highlight";
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

/** How close to the end of the text the next piece starts to load. */
const MORE_TEXT_PX = 800;
/** Pictures in Markdown don't need the full size. */
const MARKDOWN_PICTURE_EDGE = 1200;
const SLIDE_PX = 24;
const SLIDE_MS = 180;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
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
  let dialog!: HTMLDialogElement;
  let body!: HTMLDivElement;
  let next: number | null = null;
  let loadingMore = false;
  /** Which way the last step went, for the slide. */
  let stepped = 0;
  /** The snapshot the row shown came from, so its later pieces are of the same file. */
  let snapshot = 0;
  /** Bumped by each step, so answers for a row already left behind are dropped. */
  let ticket = 0;

  const folderOf = (item: Row) => item.location || props.at.folder;
  const pathOf = (item: Row) => join(folderOf(item), item.name);
  const language = () => (row() ? languageOf(row()!.name) : undefined);

  async function colored(text: string) {
    const name = language();
    return name ? highlight(text, name) : undefined;
  }

  async function addText(code: HTMLElement, text: string) {
    const html = await colored(text).catch(() => undefined);
    if (html === undefined) code.append(text);
    else code.insertAdjacentHTML("beforeend", html);
  }

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
      next = null;
      if (!found) return;
      const preview = await previewRow(view, snapshot, at);
      if (mine !== ticket) return;
      setShown(preview);
      if (preview.kind === "text") next = preview.next;
      slideIn();
    } catch (reason) {
      if (mine === ticket) setFailure(String(reason));
    }
  }

  function fillText(code: HTMLElement) {
    const preview = shown();
    if (preview?.kind === "text") void addText(code, preview.text).then(moreText);
  }

  /** Loads the next piece near the end, and again while the text still doesn't fill the body. */
  async function moreText() {
    const code = body.querySelector("code");
    if (next === null || loadingMore || !code) return;
    if (body.scrollTop + body.clientHeight < body.scrollHeight - MORE_TEXT_PX) return;
    loadingMore = true;
    const mine = ticket;
    try {
      const piece = await previewRow(props.at.view, snapshot, index(), next);
      if (mine !== ticket || piece.kind !== "text") return;
      next = piece.next;
      await addText(code, piece.text);
    } catch (reason) {
      if (mine === ticket) setFailure(String(reason));
      return;
    } finally {
      loadingMore = false;
    }
    if (mine === ticket) void moreText();
  }

  function drawPicture(canvas: HTMLCanvasElement) {
    const mine = ticket;
    const box = body.getBoundingClientRect();
    const edge = Math.ceil(Math.max(box.width, box.height) * devicePixelRatio);
    fetchBigPicture(props.at.view, snapshot, index(), edge)
      .then((picture) => {
        if (picture && mine === ticket) draw(canvas, picture);
      })
      .catch(console.error);
  }

  /** Pictures beside the file draw from this PC, and links go to the browser, never in here. */
  function fillMarkdown(article: HTMLElement) {
    const preview = shown();
    const item = row();
    if (preview?.kind !== "markdown" || !item) return;
    article.innerHTML = preview.html;
    for (const canvas of article.querySelectorAll<HTMLCanvasElement>("canvas[data-picture]")) {
      const path = resolveRelative(folderOf(item), canvas.dataset.picture!);
      // Nothing takes room until the picture is drawn, and a missing one says so.
      canvas.width = canvas.height = 0;
      const missing = () => {
        const note = document.createElement("span");
        note.className = "md-blocked";
        note.textContent = canvas.getAttribute("aria-label") || "Missing picture";
        canvas.replaceWith(note);
      };
      fetchPictureFile(path, MARKDOWN_PICTURE_EDGE)
        .then((picture) => (picture ? draw(canvas, picture) : missing()))
        .catch(missing);
    }
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
    const key = event.key;
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

  onMount(() => {
    dialog.showModal();
    body.focus();
  });

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
      onClose={props.onClose}
      onClick={(event) => event.target === dialog && props.onClose()}
    >
      <div
        ref={body}
        class="preview-body"
        tabindex="0"
        onScroll={() => void moreText()}
        onClick={onBodyClick}
      >
        <Show when={shown()} keyed>
          {(preview) => (
            <>
              {preview.kind === "text" && (
                <pre class="preview-text">
                  <code ref={fillText} class="hljs" />
                </pre>
              )}
              {preview.kind === "markdown" && <article ref={fillMarkdown} class="preview-markdown" />}
              {preview.kind === "picture" && <canvas ref={drawPicture} class="preview-picture" />}
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
        <Show when={row() && parentOf(pathOf(row()!)) !== props.at.folder && row()!.location}>
          <span class="preview-facts">{row()!.location}</span>
        </Show>
      </footer>
    </dialog>
  );
}
