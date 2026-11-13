import { createSignal, For, onMount, Show } from "solid-js";
import { openSheet } from "../../ui/sheet";
import { fitsSearch } from "../settings/search";
import { overrides, rebind, resetKey, resetKeys, unbind } from "./keybinds";
import { bound, comboOf, KEYS, keysOf, taken, type KeyCommand } from "./keys";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "./keys.css";

const GROUPS = ["Files", "Go", "View", "Tabs and panes", "Perli"] as const;

/**
 * Every key Perli answers to, and where each one is changed: press a key's chip, then the new
 * keys. A key already in use moves over from the command that had it.
 */
export function KeySheet(props: { onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  /** The command waiting for its new keys. */
  const [asking, setAsking] = createSignal<string>();
  const [said, setSaid] = createSignal("");
  let dialog!: HTMLDialogElement;
  let close!: ReturnType<typeof openSheet>;

  const shown = (group: string) =>
    KEYS.filter((command) => command.group === group && fitsSearch(`${command.label} ${keysOf(command, overrides()).join(" ")}`, query()));
  const changed = (command: KeyCommand) => command.id in overrides();

  function onKeyDown(event: KeyboardEvent) {
    const id = asking();
    if (!id) return;
    // The keys pressed are the answer, so nothing else may act on them.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") return setAsking(undefined);
    const combo = comboOf(event);
    if (!combo) return;
    const kept = taken(KEYS, combo);
    if (kept) return setSaid(`${combo} stays with ${kept.label}.`);
    const had = bound(KEYS, overrides()).get(combo);
    rebind(id, combo);
    setAsking(undefined);
    setSaid(had && had.id !== id ? `${combo} was taken from ${had.label}.` : "");
  }

  onMount(() => {
    close = openSheet(dialog);
  });

  return (
    <dialog ref={dialog} class="settings confirm key-sheet" aria-label="Keyboard shortcuts" onClose={props.onClose} onKeyDown={onKeyDown}>
      <h2>Keyboard shortcuts</h2>
      <input
        class="settings-search"
        type="search"
        aria-label="Find a key or a command"
        placeholder="Find a key or a command"
        spellcheck={false}
        value={query()}
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      <p class="key-said" role="status">
        {asking() ? "Press the new keys. Esc leaves it as it is." : said() || "Press a key's chip to change it."}
      </p>
      <div class="key-list">
        <For each={GROUPS}>
          {(group) => (
            <Show when={shown(group).length > 0}>
              <section>
                <h3>{group}</h3>
                <For each={shown(group)}>
                  {(command) => (
                    <div class="key-row" data-changed={changed(command) ? "" : undefined}>
                      <span class="key-label">{command.label}</span>
                      <Show
                        when={!command.fixed}
                        fallback={<For each={command.keys}>{(key) => <kbd class="key-chip key-fixed">{key}</kbd>}</For>}
                      >
                        <Show when={changed(command)}>
                          <button class="key-reset" aria-label={`Give ${command.label} its own keys back`} onClick={() => resetKey(command.id)}>
                            Reset
                          </button>
                        </Show>
                        <Show when={keysOf(command, overrides()).length > 0 && asking() !== command.id}>
                          <button class="key-reset" aria-label={`Leave ${command.label} with no key`} onClick={() => unbind(command.id)}>
                            Clear
                          </button>
                        </Show>
                        <button
                          class="key-chip"
                          aria-label={`Change the keys for ${command.label}`}
                          aria-pressed={asking() === command.id}
                          onClick={() => {
                            setSaid("");
                            setAsking(asking() === command.id ? undefined : command.id);
                          }}
                        >
                          {asking() === command.id ? "Press keys…" : keysOf(command, overrides()).join("  or  ") || "None"}
                        </button>
                      </Show>
                    </div>
                  )}
                </For>
              </section>
            </Show>
          )}
        </For>
      </div>
      <div class="confirm-buttons">
        <Show when={Object.keys(overrides()).length > 0}>
          <button
            class="job-choice"
            onClick={() => {
              resetKeys();
              setSaid("Every key is back as it came.");
            }}
          >
            Reset all
          </button>
        </Show>
        <button class="job-choice" onClick={() => close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}
