import { createSignal, For, onMount, Show } from "solid-js";
import { exportSettings, importSettings } from "../../api";
import { openSheet } from "../../ui/sheet";
import { fitsSearch } from "../settings/search";
import { keysText, readKeys, rebind, resetKey, resetKeys, scopeKeys, scopeName, scopeOwn, unbind, type KeyScope } from "./keybinds";
import { bound, comboOf, KEYS, keysOf, taken, type KeyCommand } from "./keys";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "./keys.css";

const GROUPS = ["Files", "Go", "View", "Tabs and panes", "Perli"] as const;
const SCOPES: { id: KeyScope; label: string }[] = [
  { id: "all", label: "Everywhere" },
  { id: "workspace", label: "This workspace" },
  { id: "folder", label: "This folder" },
];

/**
 * Every key Perli answers to, and where each one is changed: press a key's chip, then the new
 * keys. A key already in use moves over from the command that had it.
 */
export function KeySheet(props: { onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  /** The command waiting for its new keys. */
  const [asking, setAsking] = createSignal<string>();
  const [said, setSaid] = createSignal("");
  /** Where keys changed now hold. */
  const [scope, setScope] = createSignal<KeyScope>("all");
  /** The scopes there are here: no workspace on screen, no workspace keys. */
  const scopes = () => SCOPES.filter((one) => scopeName(one.id) !== undefined);
  const scopeAt = () => Math.max(0, scopes().findIndex((one) => one.id === scope()));
  const keysNow = (command: KeyCommand) => keysOf(command, scopeKeys(scope()));
  function pick(next: KeyScope) {
    setScope(next);
    setAsking(undefined);
    setSaid(next === "all" ? "" : `Keys changed now hold in ${scopeName(next)} only.`);
  }
  let dialog!: HTMLDialogElement;
  let close!: ReturnType<typeof openSheet>;

  const shown = (group: string) =>
    KEYS.filter((command) => command.group === group && fitsSearch(`${command.label} ${keysNow(command).join(" ")}`, query()));
  const changed = (command: KeyCommand) => command.id in scopeOwn(scope());

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
    const had = bound(KEYS, scopeKeys(scope())).get(combo);
    rebind(scope(), id, combo);
    setAsking(undefined);
    setSaid(had && had.id !== id ? `${combo} was taken from ${had.label}.` : "");
  }

  onMount(() => {
    close = openSheet(dialog);
  });

  /** Every key set, everywhere and in each workspace and folder, to a file to take elsewhere. */
  async function exportKeys() {
    try {
      if (await exportSettings(keysText(), "Perli keys.json")) setSaid("Keys saved.");
    } catch (failure) {
      setSaid(String(failure));
    }
  }

  async function importKeys() {
    try {
      const text = await importSettings();
      if (text !== null) setSaid(readKeys(text) ? "Keys taken in." : "That file holds no keys.");
    } catch (failure) {
      setSaid(String(failure));
    }
  }

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
      <Show when={scopes().length > 1}>
        <div class="key-scopes" role="radiogroup" aria-label="Where keys hold" style={{ "--at": scopeAt(), "--of": scopes().length }}>
          <span class="key-scope-pill" aria-hidden="true" />
          <For each={scopes()}>
            {(one) => (
              <button role="radio" aria-checked={one.id === scope()} data-tip={scopeName(one.id)} onClick={() => pick(one.id)}>
                {one.label}
              </button>
            )}
          </For>
        </div>
      </Show>
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
                          <button class="key-reset" aria-label={`Give ${command.label} its own keys back`} onClick={() => resetKey(scope(), command.id)}>
                            Reset
                          </button>
                        </Show>
                        <Show when={keysNow(command).length > 0 && asking() !== command.id}>
                          <button class="key-reset" aria-label={`Leave ${command.label} with no key`} onClick={() => unbind(scope(), command.id)}>
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
                          {asking() === command.id ? "Press keys…" : keysNow(command).join("  or  ") || "None"}
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
        <button class="job-choice key-file" onClick={() => void importKeys()}>
          Import…
        </button>
        <button class="job-choice key-file" onClick={() => void exportKeys()}>
          Export…
        </button>
        <Show when={Object.keys(scopeOwn(scope())).length > 0}>
          <button
            class="job-choice"
            onClick={() => {
              resetKeys(scope());
              setSaid(scope() === "all" ? "Every key is back as it came." : `${scopeName(scope())} keeps no keys of its own now.`);
            }}
          >
            {scope() === "all" ? "Reset all" : "Reset these"}
          </button>
        </Show>
        <button class="job-choice" onClick={() => close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}
