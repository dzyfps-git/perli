import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import { officeForget, officePicture, officeRead, type OfficeCell, type OfficeDoc, type OfficeFacts, type OfficeSheet, type OfficeSlide, type Thumb } from "../../api";
import { DataGrid } from "./DataGrid";
import { MarkdownView } from "./DocView";
import { createFind } from "./FindBar";
import { HostedPreview } from "./HostedPreview";
import { asTabs, cellOf, columnName, factsLine, startsInOffice } from "./office";
import { PasswordCard, WRONG_PASSWORD } from "./PasswordCard";
import { draw, fillPictures } from "./QuickPreview";
import { internetReader, officeHandlers } from "./viewerPrefs";

type Keys = (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;

/** Pictures in a document don't need the full size. */
const PICTURE_EDGE = 1400;
const SLIDE_PICTURE_EDGE = 1600;
const FLASH_MS = 1600;
const DONE_MS = 1400;
const ICON_FILTER = "";
const ICON_COPY = "";
const ICON_NOTES = "";
const ICON_FIND = "";

const FAMILY_NAMES = { word: "Word document", sheet: "Workbook", slides: "Presentation" };
const OFFICE_NAMES = { word: "Word", sheet: "Excel", slides: "PowerPoint" };

/** Where the preview reads its row from: the preview moves it along when its folder reloads. */
export interface RowPlace {
  view: number;
  place: { at: number; shot: number };
}

export interface OfficeViewProps extends RowPlace {
  facts: OfficeFacts;
  keys: Keys;
  onEscape: () => void;
}

/**
 * A Word, Excel or PowerPoint file. Office's own previewer shows it when Windows has one, the
 * file isn't locked and it didn't come from the internet; otherwise Perli's reader shows its
 * words, values, slides and pictures, and runs nothing in it. A switch goes between the two.
 */
export function OfficeView(live: OfficeViewProps) {
  const props = { ...live };
  const [inOffice, setInOffice] = createSignal(startsInOffice(props.facts, officeHandlers(), internetReader()));
  const [officeFailure, setOfficeFailure] = createSignal<string>();
  const [password, setPassword] = createSignal<string>();
  const [unlocking, setUnlocking] = createSignal(props.facts.locked);
  const [reading] = createResource(
    () => (inOffice() ? false : { password: password() }),
    ({ password }) => officeRead(props.view, props.place.shot, props.place.at, password),
  );
  const failure = () => (reading.error ? String(reading.error) : undefined);
  const wrong = () => (password() && failure()?.includes(WRONG_PASSWORD) ? WRONG_PASSWORD : undefined);
  createEffect(() => reading() && setUnlocking(false));
  onCleanup(() => {
    props.keys(undefined);
    if (props.facts.locked) void officeForget(props.view, props.place.shot, props.place.at).catch(console.error);
  });

  const tips = () => props.facts.facts.map(([label, value]) => `${label}: ${value}`).join("\n");
  const canOffice = () => props.facts.handler && !props.facts.locked;

  return (
    <div class="office-view" data-family={props.facts.family}>
      <header class="office-strip">
        <span class="office-kind" data-tip={tips() || undefined} tabindex={tips() ? 0 : undefined}>
          {FAMILY_NAMES[props.facts.family]}
        </span>
        <Show when={factsLine(props.facts.facts)}>
          <span class="office-facts">{factsLine(props.facts.facts)}</span>
        </Show>
        <span class="office-chips">
          <Show when={props.facts.macros}>
            <span class="office-chip office-warn" tabindex="0" data-tip="It carries macros. Perli never runs them, and Office's previewer doesn't either.">
              Has macros
            </span>
          </Show>
          <Show when={props.facts.marked}>
            <span class="office-chip" tabindex="0" data-tip="It came from the internet. Perli's reader runs nothing and fetches nothing.">
              From the internet
            </span>
          </Show>
          <Show when={props.facts.locked}>
            <span class="office-chip" tabindex="0" data-tip="It is under a password. Perli unlocks it only in memory, while this preview is open.">
              Protected
            </span>
          </Show>
          <Show when={canOffice()}>
            <button
              class="preview-chip office-switch"
              aria-pressed={inOffice()}
              onClick={() => {
                setOfficeFailure(undefined);
                setInOffice(!inOffice());
              }}
            >
              {inOffice() ? "Perli's reader" : `Preview with ${OFFICE_NAMES[props.facts.family]}`}
            </button>
          </Show>
        </span>
      </header>
      <Show when={officeFailure()}>
        <p class="office-note" role="status">
          {props.facts.marked
            ? `${OFFICE_NAMES[props.facts.family]}'s previewer won't show files from the internet, so Perli's reader does.`
            : `${OFFICE_NAMES[props.facts.family]}'s previewer didn't show it (${officeFailure()}), so Perli's reader does.`}
        </p>
      </Show>
      <Show
        when={!inOffice()}
        fallback={
          <HostedPreview
            view={props.view}
            request={props.place.shot}
            row={props.place.at}
            onEscape={props.onEscape}
            onFailure={(reason) => {
              setOfficeFailure(reason);
              setInOffice(false);
            }}
          />
        }
      >
        <Show
          when={!unlocking()}
          fallback={
            <PasswordCard
              wrong={wrong()}
              note="Perli unlocks it only in memory, while this preview is open."
              onTry={setPassword}
              onCancel={props.onEscape}
            />
          }
        >
          <Show when={reading()} keyed fallback={<Show when={failure()}>{(reason) => <p class="preview-note" role="alert">{reason()}</p>}</Show>}>
            {(doc) => (
              <>
                <Show when={doc.note}>
                  <p class="office-note">{doc.note}</p>
                </Show>
                <Reader doc={doc} view={props.view} place={props.place} keys={props.keys} />
              </>
            )}
          </Show>
        </Show>
      </Show>
    </div>
  );
}

function Reader(props: RowPlace & { doc: OfficeDoc; keys: Keys }) {
  const picture = (edge: number) => (entry: string) => officePicture(props.view, props.place.shot, props.place.at, entry, edge);
  const doc = props.doc;
  if (doc.family === "word")
    return <MarkdownView html={doc.html} source={doc.text} fill={(article) => fillPictures(article, picture(PICTURE_EDGE))} keys={props.keys} />;
  if (doc.family === "sheet") return <SheetView sheets={doc.sheets} keys={props.keys} />;
  return <SlidesView slides={doc.slides} load={picture(SLIDE_PICTURE_EDGE)} keys={props.keys} />;
}

/** A workbook a sheet at a time, with tabs along the bottom as in Excel. */
function SheetView(props: { sheets: OfficeSheet[]; keys: Keys }) {
  const first = Math.max(0, props.sheets.findIndex((sheet) => !sheet.hidden));
  const [at, setAt] = createSignal(first);
  const [filtering, setFiltering] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [missing, setMissing] = createSignal(false);
  let body: HTMLElement | undefined;
  let shown: () => OfficeCell[][] = () => [];
  const sheet = () => props.sheets[at()];
  const width = createMemo(() => sheet()?.rows.reduce((most, row) => Math.max(most, row.length), 0) ?? 0);
  const head = createMemo(() => Array.from({ length: width() }, (_, column) => columnName(column)));
  const note = () => {
    const now = sheet();
    if (!now || (now.totalRows <= now.rows.length && now.totalColumns <= width())) return undefined;
    return `The first ${now.rows.length.toLocaleString()} of ${now.totalRows.toLocaleString()} rows show, and ${width()} of ${now.totalColumns} columns.`;
  };

  /** Scrolls to a cell such as B12 and lights it for a moment. */
  function goTo(text: string) {
    const cell = cellOf(text);
    const found = cell && body?.querySelectorAll("tr")[cell.row]?.querySelectorAll("td")[cell.column + 1];
    setMissing(!found);
    if (!found) return;
    found.scrollIntoView({ block: "center", inline: "center" });
    found.setAttribute("data-flash", "");
    window.setTimeout(() => found.removeAttribute("data-flash"), FLASH_MS);
  }

  props.keys((event) => {
    if (event.ctrlKey && (event.key === "PageDown" || event.key === "PageUp")) {
      const step = event.key === "PageDown" ? 1 : -1;
      const next = at() + step;
      if (next >= 0 && next < props.sheets.length) setAt(next);
      return true;
    }
    return false;
  });
  onCleanup(() => props.keys(undefined));

  return (
    <div class="office-sheet">
      <div class="office-sheet-tools">
        <input
          class="archive-filter office-goto"
          aria-label="Go to cell"
          placeholder="Go to cell, such as B12"
          data-missing={missing() || undefined}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            goTo(event.currentTarget.value);
          }}
        />
        <button class="strip-icon" aria-label="Filter rows" aria-pressed={filtering()} onClick={() => setFiltering(!filtering())}>
          {ICON_FILTER}
        </button>
        <button
          class="strip-icon"
          aria-label={copied() ? "Copied" : "Copy the rows shown, to paste into a sheet"}
          data-done={copied() || undefined}
          onClick={() =>
            void navigator.clipboard.writeText(asTabs(shown())).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), DONE_MS);
            }, console.error)
          }
        >
          {ICON_COPY}
        </button>
      </div>
      <Show when={sheet()} keyed>
        {(now) => (
          <div class="office-grid">
            <DataGrid
              head={head()}
              rows={now.rows.map((row) => Array.from({ length: width() }, (_, column) => String(row[column] ?? "")))}
              note={note()}
              filtering={filtering()}
              body={(element) => (body = element)}
              shown={(rows) => (shown = rows)}
            />
          </div>
        )}
      </Show>
      <nav class="office-tabs" aria-label="Sheets">
        <For each={props.sheets}>
          {(one, index) => (
            <button class="office-tab-button" aria-current={index() === at() ? "true" : undefined} data-hidden={one.hidden || undefined} onClick={() => setAt(index())}>
              {one.name || `Sheet ${index() + 1}`}
            </button>
          )}
        </For>
      </nav>
    </div>
  );
}

/** A presentation a slide at a time, with a strip of slides and the speaker notes below. */
function SlidesView(props: { slides: OfficeSlide[]; load: (entry: string) => Promise<Thumb | null>; keys: Keys }) {
  const [at, setAt] = createSignal(0);
  const [notes, setNotes] = createSignal(props.slides.some((slide) => slide.notes));
  let card!: HTMLElement;
  let scroller!: HTMLDivElement;
  const find = createFind(() => card, () => scroller);
  const slide = () => props.slides[at()];
  const go = (to: number) => to >= 0 && to < props.slides.length && (setAt(to), true);

  props.keys((event) => {
    if (find.keys(event)) return true;
    if (event.ctrlKey || event.altKey || (event.target instanceof HTMLInputElement)) return false;
    // At either end the keys go on to the next file, as everywhere in the preview.
    if (event.key === "ArrowRight" || event.key === "PageDown") return go(at() + 1);
    if (event.key === "ArrowLeft" || event.key === "PageUp") return go(at() - 1);
    if (event.key === "Home") return go(0);
    if (event.key === "End") return go(props.slides.length - 1);
    if (event.key.toLowerCase() === "n") return setNotes(!notes()), true;
    return false;
  });
  onCleanup(() => {
    props.keys(undefined);
    find.close();
  });

  createEffect(
    on(at, () => {
      scroller.scrollTop = 0;
      document.querySelector(`.office-slide-strip [aria-current="true"]`)?.scrollIntoView({ block: "nearest" });
    }),
  );

  return (
    <div class="office-slides" data-notes={(notes() && !!slide()?.notes) || undefined}>
      <nav class="office-slide-strip" aria-label="Slides">
        <For each={props.slides}>
          {(one, index) => (
            <button class="office-slide-item" aria-current={index() === at() ? "true" : undefined} data-hidden={one.hidden || undefined} onClick={() => setAt(index())}>
              <span class="office-slide-number">{index() + 1}</span>
              <span class="office-slide-title">{one.title || one.lines[0]?.text || "Slide"}</span>
            </button>
          )}
        </For>
      </nav>
      <div ref={scroller} class="office-slide-stage" tabindex="-1">
        <Show when={slide()} keyed>
          {(now) => (
            <article ref={card} class="office-slide">
              <Show when={now.title}>
                <h2 class="office-slide-heading">{now.title}</h2>
              </Show>
              <For each={now.lines}>{(line) => <p class="office-slide-line" style={{ "--depth": line.depth }}>{line.text}</p>}</For>
              <Show when={now.pictures.length}>
                <div class="office-slide-pictures">
                  <For each={now.pictures}>
                    {(entry) => (
                      <canvas
                        class="office-slide-picture"
                        ref={(canvas) => void props.load(entry).then((picture) => picture && canvas.isConnected && draw(canvas, picture)).catch(() => canvas.remove())}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </article>
          )}
        </Show>
        <Show when={notes() && slide()?.notes}>
          <aside class="office-slide-notes" aria-label="Speaker notes">
            {slide()!.notes}
          </aside>
        </Show>
      </div>
      <div class="preview-tools doc-tools" role="toolbar" aria-label="Slides">
        {find.bar()}
        <button class="strip-icon" aria-label="Find" aria-keyshortcuts="Control+F" aria-pressed={find.open()} onClick={() => (find.open() ? find.close() : find.show())}>
          {ICON_FIND}
        </button>
        <Show when={props.slides.some((one) => one.notes)}>
          <button class="strip-icon" aria-label="Speaker notes" aria-keyshortcuts="N" aria-pressed={notes()} onClick={() => setNotes(!notes())}>
            {ICON_NOTES}
          </button>
        </Show>
        <span class="office-slide-count">
          {at() + 1} / {props.slides.length}
        </span>
      </div>
    </div>
  );
}

/**
 * A file only Windows' previewer shows, such as a Visio drawing. One from the internet shows
 * Windows' picture of it first, with a button for the previewer.
 */
export function WindowsView(props: RowPlace & { marked: boolean; onEscape: () => void; picture: JSX.Element }) {
  const [hosted, setHosted] = createSignal(officeHandlers() && !(props.marked && internetReader()));
  const [failure, setFailure] = createSignal<string>();
  return (
    <div class="office-view">
      <header class="office-strip">
        <Show when={props.marked}>
          <span class="office-chip" tabindex="0" data-tip="It came from the internet, so Windows' previewer waits until asked.">
            From the internet
          </span>
        </Show>
        <span class="office-chips">
          <button class="preview-chip office-switch" aria-pressed={hosted()} onClick={() => (setFailure(undefined), setHosted(!hosted()))}>
            {hosted() ? "Windows' picture" : "Preview with Windows"}
          </button>
        </span>
      </header>
      <Show when={failure()}>
        <p class="office-note" role="status">
          Windows' previewer didn't show it ({failure()}).
        </p>
      </Show>
      <Show when={hosted()} fallback={props.picture}>
        <HostedPreview
          view={props.view}
          request={props.place.shot}
          row={props.place.at}
          onEscape={props.onEscape}
          onFailure={(reason) => {
            setFailure(reason);
            setHosted(false);
          }}
        />
      </Show>
    </div>
  );
}
