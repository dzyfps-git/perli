import { createSignal, For, onMount, Show } from "solid-js";
import type { Filter } from "../../api";
import { DateField } from "../../ui/Controls";
import { parseDay } from "../../ui/dates";
import { openSheet } from "../../ui/sheet";
import type { FolderView } from "../navigation/folderView";
import { tagColor, tags } from "../tags/tags";
import { NO_FILTER, sizesAreGood, type FilterForm } from "./filter";
import "../settings/settings.css";
import "../fileops/fileops.css";

const KINDS: { value: Filter["kinds"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "files", label: "Files" },
  { value: "folders", label: "Folders" },
];

/** Rows must meet all of what is filled in. Folders have no type or size, so those leave them out. */
export function FilterDialog(props: { view: FolderView; onClose: () => void }) {
  const [form, setForm] = createSignal(props.view.filterForm());
  let dialog!: HTMLDialogElement;
  let name!: HTMLInputElement;
  let close!: ReturnType<typeof openSheet>;

  function finish(wanted: FilterForm) {
    props.view.setFilterForm(wanted);
    close(() => props.view.list()?.focus());
  }

  // A day that isn't one, such as 2026-02-30, would roll over or drop the bound.
  const datesAreGood = () => [form().from, form().to].every((day) => !day.trim() || !!parseDay(day));
  const formIsGood = () => sizesAreGood(form()) && datesAreGood();
  const apply = () => formIsGood() && finish(form());

  function toggleTag(id: number) {
    const chosen = form().tags;
    setForm({ ...form(), tags: chosen.includes(id) ? chosen.filter((tag) => tag !== id) : [...chosen, id] });
  }

  onMount(() => {
    close = openSheet(dialog);
    name.focus();
  });

  const Field = (field: {
    label: string;
    part: Exclude<keyof FilterForm, "kinds" | "tags">;
    ref?: HTMLInputElement;
  }) => (
    <label class="rename-field">
      {field.label}
      <input
        ref={field.ref}
        spellcheck={false}
        value={form()[field.part]}
        onInput={(event) => setForm({ ...form(), [field.part]: event.currentTarget.value })}
      />
    </label>
  );

  return (
    <dialog
      ref={dialog}
      class="settings confirm"
      aria-label="Filter"
      onClose={props.onClose}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) apply();
      }}
    >
      <h2>Filter</h2>
      <div class="rename-fields">
        <Field label="Name contains" part="name" ref={name} />
        <Field label="Types, such as jpg, png" part="types" />
        <Field label="Size from" part="minSize" />
        <Field label="Size to" part="maxSize" />
        <For each={[["Modified from", "from"], ["Modified to", "to"]] as const}>
          {([label, part]) => (
            <div class="rename-field">
              {label}
              <DateField label={label} value={form()[part]} onChange={(day) => setForm({ ...form(), [part]: day })} />
            </div>
          )}
        </For>
      </div>
      <div class="rename-options">
        <For each={KINDS}>
          {({ value, label }) => (
            <button
              class="job-choice rename-case"
              aria-pressed={form().kinds === value}
              onClick={() => setForm({ ...form(), kinds: value })}
            >
              {label}
            </button>
          )}
        </For>
      </div>
      <Show when={tags().length > 0}>
        <div class="rename-options">
          <For each={tags()}>
            {(tag) => (
              <button
                class="job-choice rename-case"
                aria-pressed={form().tags.includes(tag.id)}
                disabled={!!props.view.query()}
                onClick={() => toggleTag(tag.id)}
              >
                <span class="tag-dot" style={{ background: tagColor(tag.color) }} />
                {tag.name}
              </button>
            )}
          </For>
        </div>
        <Show when={props.view.query()}>
          <p class="settings-note">Rows of a search don't carry their tags yet.</p>
        </Show>
      </Show>
      <Show when={!sizesAreGood(form())}>
        <p class="confirm-summary">A size looks like 500 KB or 2 GB.</p>
      </Show>
      <Show when={!datesAreGood()}>
        <p class="confirm-summary">A day looks like 2026-03-01, and must be on the calendar.</p>
      </Show>
      <div class="confirm-buttons filter-buttons">
        <button class="job-choice" onClick={() => finish(NO_FILTER)}>
          Clear
        </button>
        <button class="job-choice" onClick={() => close()}>
          Cancel
        </button>
        <button class="job-choice" disabled={!formIsGood()} onClick={apply}>
          Apply
        </button>
      </div>
    </dialog>
  );
}
