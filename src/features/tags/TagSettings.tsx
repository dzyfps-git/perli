import { createSignal, For, Show } from "solid-js";
import { editTag, type Tag } from "../../api";
import { Swatches } from "./Swatches";
import { refreshTags, tags } from "./tags";
import "../fileops/fileops.css";

const ICON_DELETE = "";

export function TagSettings(props: { onChanged: () => void; onDelete: (tag: Tag) => void }) {
  const [failure, setFailure] = createSignal<string>();

  async function change(tag: Tag, name: string, color: number) {
    try {
      await editTag(tag.id, name, color);
      setFailure(undefined);
      props.onChanged();
    } catch (reason) {
      setFailure(String(reason));
    }
    await refreshTags();
  }

  return (
    <>
      <For each={tags()} fallback={<p class="settings-note">Right-click a file to give it a tag.</p>}>
        {(tag) => (
          <div class="tag-row">
            <label class="rename-field">
              <input
                aria-label={`Name of the tag ${tag.name}`}
                spellcheck={false}
                value={tag.name}
                onChange={(event) => change(tag, event.currentTarget.value, tag.color)}
              />
            </label>
            <Swatches label={`Color of the tag ${tag.name}`} value={tag.color} onChange={(color) => change(tag, tag.name, color)} />
            <button class="tag-delete" aria-label={`Delete the tag ${tag.name}`} onClick={() => props.onDelete(tag)}>
              {ICON_DELETE}
            </button>
          </div>
        )}
      </For>
      <Show when={failure()}>
        <p class="settings-note" role="alert">
          {failure()}
        </p>
      </Show>
    </>
  );
}
