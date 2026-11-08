import { createSignal, For, Show } from "solid-js";
import { editTag, type Tag } from "../../api";
import { Swatches } from "./Swatches";
import { refreshTags, tags } from "./tags";
import "../fileops/fileops.css";

const ICON_DELETE = "";

export function TagSettings(props: { onChanged: () => void; onDelete: (tag: Tag) => void }) {
  const [failure, setFailure] = createSignal<string>();

  // A rename sends on blur, so a color click can come before the list refreshes. Each change
  // builds on the last one wanted for that tag, and they go out one at a time.
  const wanted = new Map<number, { name: string; color: number }>();
  let queue = Promise.resolve();

  function change(tag: Tag, patch: { name?: string; color?: number }) {
    const next = { ...(wanted.get(tag.id) ?? { name: tag.name, color: tag.color }), ...patch };
    wanted.set(tag.id, next);
    queue = queue.then(async () => {
      try {
        await editTag(tag.id, next.name, next.color);
        setFailure(undefined);
        props.onChanged();
      } catch (reason) {
        setFailure(String(reason));
      }
      await refreshTags();
      if (wanted.get(tag.id) === next) wanted.delete(tag.id);
    });
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
                onChange={(event) => change(tag, { name: event.currentTarget.value })}
              />
            </label>
            <Swatches label={`Color of the tag ${tag.name}`} value={tag.color} onChange={(color) => change(tag, { color })} />
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
