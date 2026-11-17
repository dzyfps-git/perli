import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { onJobEvent, ownTemplates, runJob } from "../../api";
import { iconKindOf } from "../filelist/fileKinds";
import { iconTheme } from "../filelist/prefs";
import "../tags/tags.css";

const ICON_REMOVE = "";

/** The user's own templates: rename one, remove one (Undo brings it back), or open their folder. */
export function TemplateSettings(props: { onReveal: () => void; onFailure: (failure: unknown) => void }) {
  const [list, { refetch }] = createResource(ownTemplates);
  // A rename, a remove or its Undo changes the folder, from here or from a file list.
  const stop = onJobEvent((event) => void (event.kind === "finished" && refetch()));
  onCleanup(() => void stop.then((off) => off()));
  const [renaming, setRenaming] = createSignal<string>();

  async function rename(name: string, typed: string) {
    if (renaming() !== name) return;
    setRenaming(undefined);
    const to = typed.trim();
    if (to && to !== name) await runJob({ kind: "renameTemplate", name, to }).catch(props.onFailure);
  }

  /** The name is picked up to its type, as a rename in the file list does. */
  function pickName(input: HTMLInputElement, folder: boolean) {
    queueMicrotask(() => {
      input.focus();
      const dot = input.value.lastIndexOf(".");
      input.setSelectionRange(0, folder || dot <= 0 ? input.value.length : dot);
    });
  }

  return (
    <>
      <For each={list()} fallback={<p class="settings-note">Save any file or folder as a template from its menu, and it shows here.</p>}>
        {(template) => (
          <div class="tag-row template-row">
            <span class="file-icon" data-kind={iconKindOf(template.name, template.folder, iconTheme().extensions)} aria-hidden="true" />
            <Show
              when={renaming() === template.name}
              fallback={
                <button class="template-name" aria-label={`Rename the template ${template.name}`} onClick={() => setRenaming(template.name)}>
                  {template.name}
                </button>
              }
            >
              <label class="rename-field">
                <input
                  ref={(input) => pickName(input, template.folder)}
                  aria-label={`New name for the template ${template.name}`}
                  spellcheck={false}
                  value={template.name}
                  onBlur={(event) => void rename(template.name, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void rename(template.name, event.currentTarget.value);
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setRenaming(undefined);
                  }}
                />
              </label>
            </Show>
            <button
              class="tag-delete"
              aria-label={`Remove the template ${template.name}`}
              onClick={() => void runJob({ kind: "removeTemplate", name: template.name }).catch(props.onFailure)}
            >
              {ICON_REMOVE}
            </button>
          </div>
        )}
      </For>
      <p class="settings-note">
        A {"{date}"} in a name becomes today's date. A {"{name}"} asks you for a name when you make one, in a folder's inner names too.
      </p>
      <div class="settings-chips">
        <button class="settings-chip" onClick={props.onReveal}>
          Open templates folder
        </button>
      </div>
    </>
  );
}
