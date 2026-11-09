import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import {
  bookChapter,
  fetchArchivePicture,
  fetchBigPicture,
  fetchPictureFile,
  fetchRows,
  modelFile,
  openLink,
  previewRow,
  songAudio,
  type ArchiveEntry,
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
const ICON_PLAY = "";
const ICON_PAUSE = "";
const ICON_SONG = "";
/** Kept from one song to the next. */
const [songVolume, setSongVolume] = createSignal(1);
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
  /** The page of a comic or the chapter of a book. */
  const [page, setPage] = createSignal(0);
  let dialog!: HTMLDialogElement;
  let pageCanvas: HTMLCanvasElement | undefined;
  let chapterArticle: HTMLElement | undefined;
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
      setPage(0);
      setShown(preview);
      if (preview.kind === "text") next = preview.next;
      slideIn();
    } catch (reason) {
      if (mine === ticket) setFailure(String(reason));
    }
  }

  function fillText(code: HTMLElement) {
    const preview = shown();
    if (preview?.kind === "text") void addText(code, preview.text);
  }

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
      setFailure(String(reason));
    } finally {
      loadingMore = false;
    }
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
  function fillMarkdown(article: HTMLElement) {
    const preview = shown();
    const item = row();
    if (preview?.kind !== "markdown" || !item) return;
    article.innerHTML = preview.html;
    fillPictures(article, (name) => fetchPictureFile(resolveRelative(folderOf(item), name), MARKDOWN_PICTURE_EDGE));
  }

  /** three.js loads with the first model, and lets go of it when the preview moves on. */
  function drawModel(canvas: HTMLCanvasElement) {
    const mine = ticket;
    const { view } = props.at;
    const at = index();
    let release: (() => void) | undefined;
    let gone = false;
    onCleanup(() => {
      gone = true;
      release?.();
    });
    import("./model")
      .then(({ showModel }) => showModel(canvas, row()!.name, (part) => modelFile(view, snapshot, at, part)))
      .then((done) => (gone ? done() : (release = done)))
      .catch((reason) => mine === ticket && setFailure(`This model can't show. ${reason}`));
  }

  const edgeOfBody = () => {
    const box = body.getBoundingClientRect();
    return Math.ceil(Math.max(box.width, box.height) * devicePixelRatio);
  };

  /** A comic's page, or a book's chapter with its pictures, read from inside the file. */
  async function showPage(preview: Preview | undefined, at: number) {
    const mine = ticket;
    const { view } = props.at;
    const row = index();
    if (preview?.kind === "comic" && pageCanvas) {
      const picture = await fetchArchivePicture(view, snapshot, row, preview.pages[at], edgeOfBody());
      if (mine === ticket && page() === at && picture) draw(pageCanvas, picture);
    } else if (preview?.kind === "book" && chapterArticle) {
      const html = await bookChapter(view, snapshot, row, preview.chapters[at]);
      if (mine !== ticket || page() !== at) return;
      chapterArticle.innerHTML = html;
      body.scrollTop = 0;
      fillPictures(chapterArticle, (name) => fetchArchivePicture(view, snapshot, row, name, MARKDOWN_PICTURE_EDGE));
    }
  }

  const pageCount = () => {
    const preview = shown();
    if (preview?.kind === "comic") return preview.pages.length;
    return preview?.kind === "book" ? preview.chapters.length : 0;
  };

  /** Left and Right turn pages in a comic or a book. Up and Down still step through the rows. */
  function turn(by: number) {
    const target = page() + by;
    if (target >= 0 && target < pageCount()) setPage(target);
  }

  function onBodyClick(event: MouseEvent) {
    const link = (event.target as HTMLElement).closest("a");
    if (!link) return;
    event.preventDefault();
    const preview = shown();
    const chapter = link.dataset.chapter;
    if (chapter !== undefined && preview?.kind === "book") {
      const at = preview.chapters.indexOf(chapter);
      if (at >= 0) setPage(at);
      return;
    }
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
    // A slider takes its own arrow keys.
    if (key.startsWith("Arrow") && (event.target as HTMLElement).matches("input")) return;
    const paged = pageCount() > 0;
    if (paged && key === "ArrowLeft") turn(-1);
    else if (paged && key === "ArrowRight") turn(1);
    else if (key === "ArrowLeft" || key === "ArrowUp") step(-1);
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

  createEffect(on(index, (at) => void show(at)));
  createEffect(
    on([shown, page], ([preview, at]) => {
      showPage(preview, at).catch((reason) => setFailure(String(reason)));
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

  const pageText = () => {
    const preview = shown();
    const where = `${page() + 1} of ${pageCount()}`;
    if (preview?.kind === "comic") return `Page ${where}`;
    if (preview?.kind === "book") return [preview.title, `Chapter ${where}`].filter(Boolean).join("  ·  ");
    return "";
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
              {preview.kind === "comic" && <canvas ref={(canvas) => (pageCanvas = canvas)} class="preview-picture" />}
              {preview.kind === "book" && (
                <article ref={(article) => (chapterArticle = article)} class="preview-markdown preview-book" />
              )}
              {preview.kind === "archive" && <ArchiveList entries={preview.entries} more={preview.more} />}
              {preview.kind === "model" && (
                <div class="preview-model">
                  <canvas ref={drawModel} aria-label="3D model. Drag to turn it, right-drag to move it, scroll to zoom." />
                </div>
              )}
              {preview.kind === "song" && (
                <SongPlayer load={() => songAudio(props.at.view, snapshot, index())} />
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
        <Show when={pageText()}>
          <span class="preview-facts preview-page">{pageText()}</span>
        </Show>
        <Show when={row() && parentOf(pathOf(row()!)) !== props.at.folder && row()!.location}>
          <span class="preview-facts">{row()!.location}</span>
        </Show>
      </footer>
    </dialog>
  );
}

/** A MIDI file, rendered whole before it plays. It plays at once and stops when the preview moves on. */
function SongPlayer(props: { load: () => Promise<ArrayBuffer> }) {
  const [url, setUrl] = createSignal<string>();
  const [problem, setProblem] = createSignal<string>();
  const [playing, setPlaying] = createSignal(false);
  const [time, setTime] = createSignal(0);
  const [length, setLength] = createSignal(0);
  let audio!: HTMLAudioElement;
  let gone = false;
  props
    .load()
    .then((bytes) => gone || setUrl(URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }))))
    .catch((reason) => gone || setProblem(String(reason)));
  onCleanup(() => {
    gone = true;
    audio.pause();
    const made = url();
    if (made) URL.revokeObjectURL(made);
  });
  const clock = (seconds: number) =>
    `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  return (
    <div class="preview-song">
      <span class="song-icon" aria-hidden="true">
        {ICON_SONG}
      </span>
      <audio
        ref={(element) => {
          audio = element;
          createEffect(() => (element.volume = songVolume()));
        }}
        src={url()}
        autoplay
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={() => setLength(audio.duration)}
        onTimeUpdate={() => setTime(audio.currentTime)}
      />
      <Show
        when={url()}
        fallback={
          <p class="preview-note" role={problem() ? "alert" : undefined}>
            {problem() ?? "Getting the song ready"}
          </p>
        }
      >
        <div class="song-bar">
          <button
            class="strip-icon song-play"
            aria-label={playing() ? "Pause" : "Play"}
            onClick={() => (audio.paused ? void audio.play() : audio.pause())}
          >
            {playing() ? ICON_PAUSE : ICON_PLAY}
          </button>
          <span class="song-time">{clock(time())}</span>
          <input
            class="song-seek"
            type="range"
            aria-label="Position"
            min="0"
            max={length()}
            step="0.1"
            value={time()}
            onInput={(event) => (audio.currentTime = event.currentTarget.valueAsNumber)}
          />
          <span class="song-time">{clock(length())}</span>
          <input
            class="song-volume"
            type="range"
            aria-label="Volume"
            min="0"
            max="1"
            step="0.05"
            value={songVolume()}
            onInput={(event) => setSongVolume(event.currentTarget.valueAsNumber)}
          />
        </div>
      </Show>
    </div>
  );
}

/** What a ZIP holds, as one list of paths inside it. */
function ArchiveList(props: { entries: ArchiveEntry[]; more: boolean }) {
  const files = props.entries.filter((entry) => !entry.folder);
  const unpacked = files.reduce((sum, entry) => sum + entry.size, 0);
  const count = (amount: number, one: string) => `${amount.toLocaleString()} ${one}${amount === 1 ? "" : "s"}`;
  const summary = [
    count(files.length, "file"),
    count(props.entries.length - files.length, "folder"),
    `${formatSize(unpacked)} unpacked`,
  ].join("  \u00b7  ");
  return (
    <div class="preview-archive">
      <p class="preview-archive-sum">
        {summary}
        {props.more && ". Only the first ones are listed."}
      </p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Size</th>
            <th>Modified</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.entries}>
            {(entry) => (
              <tr data-folder={entry.folder || undefined}>
                <td>{entry.name}</td>
                <td>{entry.folder ? "" : formatSize(entry.size)}</td>
                <td>{entry.modified ?? ""}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}
