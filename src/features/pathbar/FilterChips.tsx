import { For, Show } from "solid-js";
import { DateField } from "../../ui/Controls";
import { extensionsOf, type Kind } from "../filelist/fileKinds";
import {
  hasMinSize,
  hasSince,
  hasTypes,
  NO_FILTER,
  toggleKinds,
  toggleMinSize,
  toggleSince,
  toggleTypes,
  type Since,
} from "../filelist/filter";
import { FLAT_QUERY, type FolderView } from "../navigation/folderView";

const ICON_PIN = "";
const ICON_CLEAR = "";
const ICON_MORE = "";

const TYPE_CHIPS: { label: string; hint: string; types: string[] }[] = [
  { label: "Pictures", hint: "Only pictures", types: extensionsOf("picture") },
  { label: "Videos", hint: "Only videos", types: extensionsOf("video") },
  { label: "Music", hint: "Only music and sound", types: extensionsOf("audio") },
  {
    label: "Documents",
    hint: "Only documents, sheets, slides and books",
    types: (["pdf", "doc", "text", "sheet", "slides", "markdown", "book"] as Kind[]).flatMap(extensionsOf),
  },
];

const SIZE_CHIPS = ["1 MB", "100 MB", "1 GB"];

const DATE_CHIPS: { since: Since; label: string; hint: string }[] = [
  { since: "today", label: "Today", hint: "Changed today" },
  { since: "week", label: "This week", hint: "Changed since Monday" },
  { since: "year", label: "This year", hint: "Changed since the first of January" },
];

/**
 * A row of chips under the path bar that narrow what the list shows, one tap each. The full
 * filter is one more tap away, and a filter can be pinned so the folder opens with it.
 */
export function FilterChips(props: { view: FolderView; onMore: () => void }) {
  const form = () => props.view.filterForm();
  const change = (next: typeof NO_FILTER) => props.view.setFilterForm(next);
  // A flat view and a tag search have no text for the files to hold.
  const searchesText = () => {
    const query = props.view.query();
    return !!query && query !== FLAT_QUERY && !query.startsWith("tag:");
  };
  const count = () => props.view.folder()?.count ?? 0;

  function Chip(chip: { label: string; hint: string; pressed: boolean; onClick: () => void }) {
    return (
      <button class="chip" aria-label={chip.hint} aria-pressed={chip.pressed} onClick={() => chip.onClick()}>
        {chip.label}
      </button>
    );
  }

  return (
    <div
      class="filter-chips"
      role="toolbar"
      aria-label="Quick filters"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.target instanceof HTMLInputElement) return;
        event.stopPropagation();
        props.view.list()?.focus();
      }}
    >
      <Show when={searchesText()}>
        <Chip
          label="Inside files"
          hint="Also look inside text files of up to 2 MB"
          pressed={props.view.inside()}
          onClick={() => props.view.setInside(!props.view.inside())}
        />
        <span class="chip-gap" />
      </Show>
      <Chip
        label="Files"
        hint="Only files"
        pressed={form().kinds === "files"}
        onClick={() => change(toggleKinds(form(), "files"))}
      />
      <Chip
        label="Folders"
        hint="Only folders"
        pressed={form().kinds === "folders"}
        onClick={() => change(toggleKinds(form(), "folders"))}
      />
      <For each={TYPE_CHIPS}>
        {(chip) => (
          <Chip
            label={chip.label}
            hint={chip.hint}
            pressed={hasTypes(form(), chip.types)}
            onClick={() => change(toggleTypes(form(), chip.types))}
          />
        )}
      </For>
      <span class="chip-gap" />
      <For each={SIZE_CHIPS}>
        {(size) => (
          <Chip
            label={`Over ${size}`}
            hint={`Only files over ${size}`}
            pressed={hasMinSize(form(), size)}
            onClick={() => change(toggleMinSize(form(), size))}
          />
        )}
      </For>
      <span class="chip-gap" />
      <For each={DATE_CHIPS}>
        {(chip) => (
          <Chip
            label={chip.label}
            hint={chip.hint}
            pressed={hasSince(form(), chip.since)}
            onClick={() => change(toggleSince(form(), chip.since))}
          />
        )}
      </For>
      <span class="chip-since">
        Since
        <DateField label="Changed since" value={form().from} onChange={(from) => change({ ...form(), from })} />
      </span>
      <span class="chip-gap" />
      <button class="chip chip-icon" aria-label="More ways to filter…" onClick={() => props.onMore()}>
        <span aria-hidden="true">{ICON_MORE}</span>
      </button>
      <Show when={props.view.filtered()}>
        <Show when={!props.view.query()}>
          <button
            class="chip chip-icon"
            aria-label={props.view.filterPinned() ? "Stop keeping this filter for this folder" : "Keep this filter for this folder"}
            aria-pressed={props.view.filterPinned()}
            onClick={() => props.view.pinFilter(!props.view.filterPinned())}
          >
            <span aria-hidden="true">{ICON_PIN}</span>
          </button>
        </Show>
        <button class="chip chip-icon chip-clear" aria-label="Clear the filter" onClick={() => change(NO_FILTER)}>
          <span aria-hidden="true">{ICON_CLEAR}</span>
        </button>
        <span class="chip-count" aria-live="polite">
          {count() === 1 ? "1 fits" : `${count().toLocaleString()} fit`}
        </span>
      </Show>
    </div>
  );
}
