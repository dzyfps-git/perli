import { createSignal, For, onMount, Show } from "solid-js";
import type { Filter } from "../../api";
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

  function finish(wanted: FilterForm) {
    dialog.close();
    props.view.setFilterForm(wanted);
    props.view.list()?.focus();
  }

  const apply = () => sizesAreGood(form()) && finish(form());

  function toggleTag(id: number) {
    const chosen = form().tags;
    setForm({ ...form(), tags: chosen.includes(id) ? chosen.filter((tag) => tag !== id) : [...chosen, id] });
  }

  onMount(() => {
    dialog.showModal();
    name.focus();
  });

  const Field = (field: {
    label: string;
    part: Exclude<keyof FilterForm, "kinds" | "tags">;
    type?: string;
    ref?: HTMLInputElement;
  }) => (
    <label class="rename-field">
      {field.label}
      <input
        ref={field.ref}
        type={field.type ?? "text"}
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
        <Field label="Modified from" part="from" type="date" />
        <Field label="Modified to" part="to" type="date" />
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
      <div class="confirm-buttons filter-buttons">
        <button class="job-choice" onClick={() => finish(NO_FILTER)}>
          Clear
        </button>
        <button class="job-choice" onClick={() => dialog.close()}>
          Cancel
        </button>
        <button class="job-choice" disabled={!sizesAreGood(form())} onClick={apply}>
          Apply
        </button>
      </div>
    </dialog>
  );
}
