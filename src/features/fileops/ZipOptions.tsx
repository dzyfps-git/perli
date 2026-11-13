import { createSignal, For, onMount, Show } from "solid-js";
import type { Selection, ZipLevel } from "../../api";
import { saved, stored } from "../filelist/prefs";
import "./fileops.css";

export interface ZipRequest {
  selection: Selection;
  x: number;
  y: number;
  confirm: (level: ZipLevel, password: string | undefined) => void;
}

const LEVELS: { value: ZipLevel; label: string; note: string }[] = [
  { value: "store", label: "Store", note: "Quickest. Best for photos, films and music, which squeeze no further." },
  { value: "fast", label: "Fast", note: "Quick, and a little bigger." },
  { value: "normal", label: "Normal", note: "A good balance of size and time." },
  { value: "best", label: "Best", note: "The smallest archive, and the slowest to make." },
];
const EDGE_GAP = 8;
const ICON_SHOW = "";
const ICON_HIDE = "";

const known = (value: unknown): value is ZipLevel => LEVELS.some((level) => level.value === value);
/** The level is kept for next time. A password never is. */
const [level, setLevel] = stored<ZipLevel>("zip-level", known(saved("zip-level")) ? (saved("zip-level") as ZipLevel) : "normal");

/** A small popover for how hard to squeeze a new ZIP, and an optional password. */
export function ZipOptions(props: { request: ZipRequest; onClose: () => void }) {
  let box!: HTMLDivElement;
  let password!: HTMLInputElement;
  const [shown, setShown] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const count = () => props.request.selection.rows.length;

  function confirm() {
    box.hidePopover();
    props.request.confirm(level(), typed() || undefined);
  }

  function place() {
    const { width, height } = box.getBoundingClientRect();
    box.style.left = `${Math.max(EDGE_GAP, Math.min(props.request.x, innerWidth - width - EDGE_GAP))}px`;
    box.style.top = `${Math.max(EDGE_GAP, Math.min(props.request.y, innerHeight - height - EDGE_GAP))}px`;
  }

  onMount(() => {
    box.showPopover();
    place();
    box.querySelector<HTMLButtonElement>(".zip-level[aria-checked='true']")?.focus();
  });

  return (
    <div
      ref={box}
      class="new-gallery zip-options"
      popover="auto"
      role="dialog"
      aria-label="Compress to ZIP"
      onToggle={(event) => (event as ToggleEvent).newState === "closed" && props.onClose()}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.target instanceof HTMLButtonElement) return;
        event.preventDefault();
        confirm();
      }}
    >
      <h3>Compress {count() === 1 ? "1 item" : `${count().toLocaleString()} items`} to ZIP</h3>
      <div class="zip-levels" role="radiogroup" aria-label="Compression">
        <For each={LEVELS}>
          {(choice) => (
            <button class="job-choice zip-level" role="radio" aria-checked={level() === choice.value} onClick={() => setLevel(choice.value)}>
              {choice.label}
            </button>
          )}
        </For>
      </div>
      <p class="zip-note">{LEVELS.find((choice) => choice.value === level())?.note}</p>
      <label class="rename-field zip-password">
        Password, if you want one
        <span class="zip-password-row">
          <input
            ref={password}
            type={shown() ? "text" : "password"}
            autocomplete="new-password"
            spellcheck={false}
            value={typed()}
            onInput={(event) => setTyped(event.currentTarget.value)}
          />
          <button
            class="field-step"
            type="button"
            aria-label={shown() ? "Hide the password" : "Show the password"}
            onClick={() => {
              setShown(!shown());
              password.focus();
            }}
          >
            {shown() ? ICON_HIDE : ICON_SHOW}
          </button>
        </span>
      </label>
      <Show when={typed()}>
        <p class="zip-note">
          Any unzip app opens it with this password. The lock is the classic ZIP kind, fine against a glance, not for secrets.
        </p>
      </Show>
      <div class="confirm-buttons">
        <button class="job-choice" onClick={() => box.hidePopover()}>
          Cancel
        </button>
        <button class="job-choice" onClick={confirm}>
          Compress
        </button>
      </div>
    </div>
  );
}
