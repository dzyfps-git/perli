import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { fetchThumb, peekFolder, peekText, type FolderStart, type Row, type Thumb } from "../../api";
import { formatSize } from "../../ui/format";
import { relativeTo } from "../navigation/path";
import { tagColor, tags } from "../tags/tags";
import { besidePoint } from "./layout";
import { cachedThumb } from "./thumbs";
import { typeText } from "./typeNames";

/** What a card is for: one row of one snapshot, and where the pointer rested. */
export interface CardAsk {
  row: Row;
  index: number;
  snapshot: number;
  /** Names the row's picture in the shared cache. */
  thumbKey: string;
  x: number;
  y: number;
}

const dates = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * A row's details, with a preview of its text, its picture or what a folder holds. It never takes
 * the pointer, until Shift pins it: then it stays, and its text can be selected and copied.
 */
export function HoverCard(props: {
  ask: CardAsk;
  view: number;
  folder: string;
  sync?: string;
  /** Told when the card is pinned, and when a pinned card is let go. */
  onPin?: (pinned: boolean) => void;
}) {
  const [inside, setInside] = createSignal<FolderStart>();
  const [pinned, setPinned] = createSignal(false);
  const [text, setText] = createSignal<string>();
  const [thumb, setThumb] = createSignal<Thumb>();
  let box!: HTMLDivElement;
  const { row } = props.ask;
  const rowTags = () => row.tags.flatMap((id) => tags().find((tag) => tag.id === id) ?? []);
  const facts = () =>
    [
      ["Type", typeText(row.name, row.isDir)],
      ["Size", row.isDir && !row.size ? "" : formatSize(row.size)],
      ["Modified", row.modified > 0 ? dates.format(row.modified) : ""],
      ["Created", row.created > 0 ? dates.format(row.created) : ""],
      ["Folder", row.location ? relativeTo(props.folder, row.location) || "." : ""],
      ["Sync", props.sync ?? ""],
    ].filter(([, value]) => value);

  function place() {
    const { width, height } = box.getBoundingClientRect();
    const spot = besidePoint(props.ask.x, props.ask.y, width, height, { width: innerWidth, height: innerHeight });
    box.style.left = `${spot.left}px`;
    box.style.top = `${spot.top}px`;
  }

  function drawThumb(canvas: HTMLCanvasElement) {
    const picture = thumb()!;
    canvas.width = picture.width;
    canvas.height = picture.height;
    canvas.getContext("2d")!.putImageData(new ImageData(picture.pixels, picture.width, picture.height), 0, 0);
  }

  async function loadPreview() {
    const { view } = props;
    const { snapshot, index, thumbKey } = props.ask;
    const peeked = await peekText(view, snapshot, index).catch(() => null);
    if (peeked) return setText(peeked);
    const picture = cachedThumb(thumbKey) ?? (await fetchThumb(view, snapshot, index).catch(() => null));
    if (picture) setThumb(picture);
  }

  function pin(on: boolean) {
    setPinned(on);
    props.onPin?.(on);
  }

  onMount(() => {
    place();
    const loaded = row.isDir
      ? peekFolder(props.view, props.ask.snapshot, props.ask.index).then((found) => found && setInside(found), () => undefined)
      : loadPreview();
    loaded.then(() => box.isConnected && place());
    // Shift pins the card. Any other key, or a press outside it, lets a pinned card go.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Shift" && !event.repeat && !pinned()) pin(true);
      else if (pinned() && !["Shift", "Control", "Alt", "Meta"].includes(event.key) && !(event.ctrlKey && event.key.toLowerCase() === "c")) pin(false);
    };
    const onPress = (event: PointerEvent) => pinned() && !box.contains(event.target as Node) && pin(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPress, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPress, true);
    });
  });

  return (
    <Portal>
      <div ref={box} class="hover-card" role="tooltip" data-pinned={pinned() || undefined}>
        <Show when={text()}>
          <pre class="hover-card-text">{text()}</pre>
        </Show>
        <Show when={thumb()}>
          <canvas ref={drawThumb} class="hover-card-picture" />
        </Show>
        <Show when={inside()}>
          {(found) => (
            <Show when={found().count > 0} fallback={<p class="hover-card-hint">Nothing in this folder.</p>}>
              <ul class="hover-card-inside">
                <For each={found().names}>{([name, folder]) => <li data-folder={folder || undefined}>{name}</li>}</For>
                <Show when={found().count > found().names.length}>
                  <li class="hover-card-rest">
                    and {(found().count - found().names.length).toLocaleString()}
                    {found().more ? " or" : ""} more
                  </li>
                </Show>
              </ul>
            </Show>
          )}
        </Show>
        <p class="hover-card-name">{row.name}</p>
        <dl class="hover-card-facts">
          <For each={facts()}>
            {([label, value]) => (
              <>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </>
            )}
          </For>
        </dl>
        <Show when={rowTags().length > 0}>
          <ul class="hover-card-tags">
            <For each={rowTags()}>
              {(tag) => (
                <li>
                  <span class="tag-dot" style={{ background: tagColor(tag.color) }} />
                  {tag.name}
                </li>
              )}
            </For>
          </ul>
        </Show>
        <p class="hover-card-hint">{pinned() ? "Pinned. Esc lets it go." : "Shift pins this card."}</p>
      </div>
    </Portal>
  );
}
