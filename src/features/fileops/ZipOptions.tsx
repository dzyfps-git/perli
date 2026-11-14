import { createSignal, For, onMount, Show } from "solid-js";
import type { ArchiveFormat, Selection, ZipLevel } from "../../api";
import { saved, stored } from "../filelist/prefs";
import "./fileops.css";

/** What the popover settled on. */
export interface ZipChoice {
  level: ZipLevel;
  format: ArchiveFormat;
  password?: string;
  /** A ZIP's lock is AES-256 rather than the classic kind. */
  aes: boolean;
}

export interface ZipRequest {
  selection: Selection;
  x: number;
  y: number;
  confirm: (choice: ZipChoice) => void;
}

const FORMATS: { value: ArchiveFormat; label: string; note: string }[] = [
  { value: "zip", label: "ZIP", note: "Opens everywhere, Windows included." },
  { value: "7z", label: "7z", note: "Usually smaller. A password locks the names inside too. Windows 11 and 7-Zip open it." },
  { value: "tar", label: "TAR", note: "Files kept together as they are, nothing squeezed. The usual kind on Linux and Mac." },
  { value: "tar.gz", label: "TAR.GZ", note: "A squeezed TAR, the usual way to send files to Linux and Mac." },
];
const LEVELS: { value: ZipLevel; label: string; note: string }[] = [
  { value: "store", label: "Store", note: "Quickest. Best for photos, films and music, which squeeze no further." },
  { value: "fast", label: "Fast", note: "Quick, and a little bigger." },
  { value: "normal", label: "Normal", note: "A good balance of size and time." },
  { value: "best", label: "Best", note: "The smallest archive, and the slowest to make." },
];
const LOCKS: { aes: boolean; label: string; note: string }[] = [
  { aes: false, label: "Classic", note: "Windows and every unzip app open it. Fine against a glance, not for secrets." },
  { aes: true, label: "AES-256", note: "A strong lock. Windows can't open it on its own; Perli, 7-Zip and WinRAR can." },
];
const EDGE_GAP = 8;
const ICON_SHOW = "";
const ICON_HIDE = "";

const knownLevel = (value: unknown): value is ZipLevel => LEVELS.some((level) => level.value === value);
const knownFormat = (value: unknown): value is ArchiveFormat => FORMATS.some((format) => format.value === value);
/** The choices are kept for next time. A password never is. */
const [level, setLevel] = stored<ZipLevel>("zip-level", knownLevel(saved("zip-level")) ? (saved("zip-level") as ZipLevel) : "normal");
const [format, setFormat] = stored<ArchiveFormat>("zip-format", knownFormat(saved("zip-format")) ? (saved("zip-format") as ArchiveFormat) : "zip");
const [aes, setAes] = stored<boolean>("zip-aes", saved("zip-aes") === true);

/** A small popover for the kind of a new archive, how hard to squeeze it, and a password. */
export function ZipOptions(props: { request: ZipRequest; onClose: () => void }) {
  let box!: HTMLDivElement;
  let password!: HTMLInputElement;
  const [shown, setShown] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const count = () => props.request.selection.rows.length;
  const squeezes = () => format() !== "tar";
  const locks = () => format() === "zip" || format() === "7z";

  function confirm() {
    box.hidePopover();
    props.request.confirm({ level: level(), format: format(), password: (locks() && typed()) || undefined, aes: aes() });
  }

  function place() {
    const { width, height } = box.getBoundingClientRect();
    box.style.left = `${Math.max(EDGE_GAP, Math.min(props.request.x, innerWidth - width - EDGE_GAP))}px`;
    box.style.top = `${Math.max(EDGE_GAP, Math.min(props.request.y, innerHeight - height - EDGE_GAP))}px`;
  }

  onMount(() => {
    box.showPopover();
    place();
    box.querySelector<HTMLButtonElement>(".zip-format[aria-checked='true']")?.focus();
  });

  /** Arrow keys move the choice along a row of chips, as in any radio group. */
  function arrows<T>(event: KeyboardEvent, values: T[], now: T, pick: (value: T) => void) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = values[(values.indexOf(now) + step + values.length) % values.length];
    pick(next);
    queueMicrotask(() => (event.currentTarget as HTMLElement | null)?.querySelector<HTMLButtonElement>("[aria-checked='true']")?.focus());
  }

  return (
    <div
      ref={box}
      class="new-gallery zip-options"
      popover="auto"
      role="dialog"
      aria-label="Compress"
      onToggle={(event) => (event as ToggleEvent).newState === "closed" && props.onClose()}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.target instanceof HTMLButtonElement) return;
        event.preventDefault();
        confirm();
      }}
    >
      <h3>
        Compress {count() === 1 ? "1 item" : `${count().toLocaleString()} items`} to {FORMATS.find((choice) => choice.value === format())?.label}
      </h3>
      <div
        class="zip-levels zip-formats"
        role="radiogroup"
        aria-label="Kind of archive"
        onKeyDown={(event) => arrows(event, FORMATS.map((choice) => choice.value), format(), setFormat)}
      >
        <For each={FORMATS}>
          {(choice) => (
            <button class="job-choice zip-format" role="radio" aria-checked={format() === choice.value} onClick={() => setFormat(choice.value)}>
              {choice.label}
            </button>
          )}
        </For>
      </div>
      <p class="zip-note">{FORMATS.find((choice) => choice.value === format())?.note}</p>
      <Show when={squeezes()}>
        <div
          class="zip-levels zip-reveal"
          role="radiogroup"
          aria-label="Compression"
          onKeyDown={(event) => arrows(event, LEVELS.map((choice) => choice.value), level(), setLevel)}
        >
          <For each={LEVELS}>
            {(choice) => (
              <button class="job-choice zip-level" role="radio" aria-checked={level() === choice.value} onClick={() => setLevel(choice.value)}>
                {choice.label}
              </button>
            )}
          </For>
        </div>
        <p class="zip-note">{LEVELS.find((choice) => choice.value === level())?.note}</p>
      </Show>
      <Show when={locks()} fallback={<p class="zip-note zip-reveal">A TAR has no lock, so it takes no password.</p>}>
        <label class="rename-field zip-password zip-reveal">
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
          <Show
            when={format() === "zip"}
            fallback={<p class="zip-note zip-reveal">Locked with AES-256, names included. Perli, 7-Zip and WinRAR open it with this password.</p>}
          >
            <div class="zip-levels zip-locks zip-reveal" role="radiogroup" aria-label="Lock" onKeyDown={(event) => arrows(event, [false, true], aes(), setAes)}>
              <For each={LOCKS}>
                {(choice) => (
                  <button class="job-choice zip-lock" role="radio" aria-checked={aes() === choice.aes} onClick={() => setAes(choice.aes)}>
                    {choice.label}
                  </button>
                )}
              </For>
            </div>
            <p class="zip-note">{LOCKS.find((choice) => choice.aes === aes())?.note}</p>
          </Show>
        </Show>
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
