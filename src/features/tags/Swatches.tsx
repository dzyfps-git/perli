import { For } from "solid-js";
import { TAG_COLORS, tagColor } from "./tags";

export function Swatches(props: { label: string; value: number; onChange: (color: number) => void }) {
  return (
    <div class="tag-swatches" role="radiogroup" aria-label={props.label}>
      <For each={TAG_COLORS}>
        {(name, color) => (
          <button
            class="tag-swatch"
            role="radio"
            aria-label={name}
            aria-checked={props.value === color()}
            style={{ background: tagColor(color()) }}
            onClick={() => props.onChange(color())}
          />
        )}
      </For>
    </div>
  );
}
