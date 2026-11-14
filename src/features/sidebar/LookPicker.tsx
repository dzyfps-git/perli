import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { fetchPictureFile, folderPictures, pickPicture } from "../../api";
import { openSheet } from "../../ui/sheet";
import { baseName } from "../navigation/path";
import { draw } from "../preview/QuickPreview";
import { TAG_COLORS, tagColor } from "../tags/tags";
import { findIcons } from "./folderIcons";
import { coverPosition, type Look } from "./placeLists";
import { lookOf, ownLookOf, setLook } from "./saved";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "./sidebar.css";

const ICON_FOLDER = "";

/** How many pictures from inside the folder the cover strip offers. */
const MOST_CHOICES = 200;
/** The edge of a picture in the strip, in CSS pixels. */
const CHOICE_EDGE = 64;
/** Names that say a picture was made to be the folder's cover. */
const SUGGESTED = /^(cover|folder|front)\.[^.]+$/i;
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

interface Choice {
  path: string;
  name: string;
  suggested: boolean;
}

/** The folder's pictures for the strip: a suggested cover first, then the rest by name. */
const choicesOf = (paths: string[]): Choice[] =>
  paths
    .map((path) => ({ path, name: baseName(path), suggested: SUGGESTED.test(baseName(path)) }))
    .sort((a, b) => Number(b.suggested) - Number(a.suggested) || byName.compare(a.name, b.name));

/** A picture drawn into `canvas` once it comes, at `edge` CSS pixels. Says how wide it is. */
function drawPicture(canvas: HTMLCanvasElement, path: string, edge: number) {
  return fetchPictureFile(path, Math.ceil(edge * devicePixelRatio)).then((picture) => {
    if (!picture) throw new Error("Windows can't read that picture");
    draw(canvas, picture);
    return picture.width > picture.height;
  });
}

/** One picture in the cover strip. It is read only once it scrolls near. */
function CoverChoice(props: { choice: Choice; picked: boolean; first: boolean; strip: HTMLElement; onPick: () => void }) {
  let button!: HTMLButtonElement;
  let canvas!: HTMLCanvasElement;
  onMount(() => {
    const near = new IntersectionObserver(
      (seen) => {
        if (!seen.some((entry) => entry.isIntersecting)) return;
        near.disconnect();
        drawPicture(canvas, props.choice.path, CHOICE_EDGE).then(
          () => (button.dataset.drawn = ""),
          () => (button.dataset.failed = ""),
        );
      },
      { root: props.strip, rootMargin: "0px 256px" },
    );
    near.observe(button);
    onCleanup(() => near.disconnect());
  });
  return (
    <button
      ref={button}
      class="cover-choice"
      role="radio"
      aria-checked={props.picked}
      aria-label={props.choice.suggested ? `${props.choice.name}, suggested` : props.choice.name}
      tabIndex={props.picked || props.first ? 0 : -1}
      onClick={() => props.onPick()}
    >
      <canvas ref={canvas} aria-hidden="true" />
      <Show when={props.choice.suggested}>
        <span class="cover-suggested" aria-hidden="true">
          Suggested
        </span>
      </Show>
    </button>
  );
}

/** Which end of a cover the tiles keep, said the way the picture is cut. */
const CROPS: [Look["coverAt"], string, string][] = [
  ["start", "Top", "Left"],
  [undefined, "Middle", "Middle"],
  ["end", "Bottom", "Right"],
];

/** A folder's color, icon and cover in one sheet, with a search through the icons. */
export function LookPicker(props: { path: string; onClose: () => void }) {
  const [typed, setTyped] = createSignal("");
  const look = () => lookOf(props.path);
  const icons = createMemo(() => findIcons(typed()));
  let dialog!: HTMLDialogElement;
  let search!: HTMLInputElement;
  let close!: ReturnType<typeof openSheet>;

  /** Folders inside, at any depth and also ones made later, take this look unless they have their own. */
  const handsDown = () => ownLookOf(props.path)?.inside === true;
  const canHand = () => ownLookOf(props.path)?.color !== undefined || ownLookOf(props.path)?.icon !== undefined;

  let strip!: HTMLDivElement;
  let ring!: HTMLSpanElement;
  const cover = () => look()?.cover;
  /** Whether the cover is wider than tall, so the crop choices say left and right. */
  const [wide, setWide] = createSignal(false);
  const [found] = createResource(
    () => props.path,
    (path) => folderPictures(path, MOST_CHOICES).then(choicesOf, () => [] as Choice[]),
  );
  /** A cover from elsewhere, or past the first 200, leads the strip so it can still be seen picked. */
  const choices = createMemo(() => {
    const list = found() ?? [];
    const own = cover();
    return own && found() && !list.some((choice) => samePath(choice.path, own))
      ? [{ path: own, name: baseName(own), suggested: false }, ...list]
      : list;
  });
  const pickCover = (path: string) => setLook(props.path, { cover: path });

  // The ring slides from the picture picked before to the one picked now.
  createEffect(() => {
    const own = cover();
    choices();
    const picked = own ? strip?.querySelector<HTMLElement>('.cover-choice[aria-checked="true"]') : null;
    ring.hidden = !picked;
    if (!picked) {
      delete ring.dataset.placed;
      return;
    }
    ring.style.translate = `${picked.offsetLeft}px ${picked.offsetTop}px`;
    if (ring.dataset.placed === undefined) {
      picked.scrollIntoView({ block: "nearest", inline: "center" });
      requestAnimationFrame(() => (ring.dataset.placed = ""));
    }
  });

  /** The arrow keys, Home and End walk the strip. Enter or Space picks, as buttons do. */
  function walkStrip(event: KeyboardEvent) {
    const all = [...strip.querySelectorAll<HTMLButtonElement>(".cover-choice")];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: all.length - 1 }[event.key];
    if (to === undefined || at < 0) return;
    event.preventDefault();
    const next = all[Math.max(0, Math.min(all.length - 1, to))];
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }

  async function browse() {
    const path = await pickPicture(props.path).catch(() => null);
    if (path) pickCover(path);
  }

  onMount(() => {
    close = openSheet(dialog);
    search.focus();
  });

  return (
    <dialog ref={dialog} class="settings confirm look-picker" aria-label="Folder look" onClose={props.onClose}>
      <div class="look-head">
        <span
          class="look-sample"
          classList={{ "look-sample-covered": !!cover() }}
          style={{ "--look-color": look()?.color === undefined ? undefined : tagColor(look()!.color!) }}
          aria-hidden="true"
        >
          <Show when={cover()} keyed fallback={look()?.icon ?? ICON_FOLDER}>
            {(path) => (
              <>
                <canvas
                  ref={(canvas) => drawPicture(canvas, path, 56).then(setWide, () => {})}
                  style={{ "object-position": coverPosition(look()?.coverAt) }}
                />
                <span class="look-badge">{look()?.icon ?? ICON_FOLDER}</span>
              </>
            )}
          </Show>
        </span>
        <h2>{baseName(props.path) || props.path}</h2>
      </div>
      <h3 class="look-title">Color</h3>
      <div class="look-colors" role="radiogroup" aria-label="Color">
        <button
          class="look-color look-none"
          role="radio"
          aria-label="No color"
          aria-checked={look()?.color === undefined}
          onClick={() => setLook(props.path, { color: undefined })}
        />
        <For each={TAG_COLORS}>
          {(name, color) => (
            <button
              class="look-color"
              role="radio"
              aria-label={name}
              aria-checked={look()?.color === color()}
              style={{ background: tagColor(color()) }}
              onClick={() => setLook(props.path, { color: color() })}
            />
          )}
        </For>
      </div>
      <h3 class="look-title">Icon</h3>
      <input
        ref={search}
        class="look-search"
        type="search"
        placeholder="Find an icon: travel, music, code…"
        aria-label="Find an icon"
        spellcheck={false}
        value={typed()}
        onInput={(event) => setTyped(event.currentTarget.value)}
      />
      <div class="look-icons" role="radiogroup" aria-label="Icon">
        <Show when={!typed()}>
          <button
            class="look-icon"
            role="radio"
            aria-label="Plain folder"
            aria-checked={look()?.icon === undefined}
            onClick={() => setLook(props.path, { icon: undefined })}
          >
            {ICON_FOLDER}
          </button>
        </Show>
        <For each={icons()} fallback={<p class="look-none-found">No icon goes by that name.</p>}>
          {(icon) => (
            <button
              class="look-icon"
              role="radio"
              aria-label={icon.label}
              aria-checked={look()?.icon === icon.glyph}
              onClick={() => setLook(props.path, { icon: icon.glyph })}
            >
              {icon.glyph}
            </button>
          )}
        </For>
      </div>
      <h3 class="look-title">Cover</h3>
      <div class="cover-strip" ref={strip} role="radiogroup" aria-label="Cover" onKeyDown={walkStrip}>
        <span class="cover-ring" ref={ring} hidden aria-hidden="true" />
        <For each={choices()}>
          {(choice, index) => (
            <CoverChoice
              choice={choice}
              picked={!!cover() && samePath(cover()!, choice.path)}
              first={!cover() && index() === 0}
              strip={strip}
              onPick={() => pickCover(choice.path)}
            />
          )}
        </For>
      </div>
      <Show when={found() && choices().length === 0}>
        <p class="settings-note">No pictures right in this folder. Browse for one anywhere on this PC.</p>
      </Show>
      <div class="look-cover">
        <Show when={cover()}>
          {(own) => (
            <>
              <span class="look-cover-name">{baseName(own())}</span>
              <div class="look-crops" role="radiogroup" aria-label="Part of the cover tiles keep">
                <For each={CROPS}>
                  {([at, tall, across]) => (
                    <button
                      class="look-crop"
                      role="radio"
                      aria-checked={look()?.coverAt === at}
                      onClick={() => setLook(props.path, { coverAt: at })}
                    >
                      {wide() ? across : tall}
                    </button>
                  )}
                </For>
              </div>
            </>
          )}
        </Show>
        <button class="job-choice" onClick={browse}>
          Browse…
        </button>
        <Show when={cover()}>
          <button class="job-choice" onClick={() => setLook(props.path, { cover: undefined })}>
            Remove cover
          </button>
        </Show>
      </div>
      <Show when={handsDown()}>
        <p class="settings-note" role="status">
          Folders inside look the same, new ones too, unless they have a look of their own.
        </p>
      </Show>
      <div class="confirm-buttons">
        <button
          class="job-choice look-inside"
          aria-pressed={handsDown()}
          disabled={!canHand()}
          onClick={() => setLook(props.path, { inside: !handsDown() })}
        >
          {handsDown() ? "Folders inside go their own way" : "Same look for folders inside"}
        </button>
        <button class="job-choice" onClick={() => close()}>
          Done
        </button>
      </div>
    </dialog>
  );
}
