import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { rankNames } from "../../api";
import { saved, stored } from "../filelist/prefs";
import "./palette.css";

export interface Command {
  label: string;
  keys?: string;
  /** A Segoe Fluent Icons glyph. */
  icon?: string;
  /** The heading it sits under before anything is typed, and a quiet hint once something is. */
  group?: string;
  run: () => void;
}

/** Commands of one group side by side, the groups in the order they first come up. */
export function byGroup<T extends { group?: string }>(commands: T[]) {
  const groups = new Map<string | undefined, T[]>();
  for (const command of commands) groups.set(command.group, [...(groups.get(command.group) ?? []), command]);
  return [...groups.values()].flat();
}

const optionId = (index: number) => `palette-option-${index}`;
/** How many commands run lately come first, before anything is typed. */
const MOST_RECENT = 5;

const [recent, setRecent] = stored<string[]>(
  "palette-recent",
  ((saved("palette-recent") as unknown[] | null) ?? []).filter((label): label is string => typeof label === "string"),
);

/** The commands run lately first, newest at the top, then the rest in their own order. */
export function recentFirst<T extends { label: string }>(commands: T[], labels: string[]) {
  const first = labels.flatMap((label) => commands.filter((command) => command.label === label).slice(0, 1));
  return { first, rest: commands.filter((command) => !first.includes(command)) };
}

/** Runs anything by name. Names go through the matcher a folder search uses. */
export function Palette(props: {
  open: boolean;
  commands: () => Command[];
  onClose: () => void;
  /** For when what had the focus is gone by the time this closes. */
  focusList: () => void;
  /** Commands made from what is typed, like "sort by size", which come first. */
  words?: (text: string) => Command[];
  /** Asks for one kind of thing, such as a tab, instead of any command. Nothing run is kept as recent. */
  scope?: { label: string; placeholder: string };
}) {
  const [text, setText] = createSignal("");
  const [shown, setShown] = createSignal<Command[]>([]);
  const [active, setActive] = createSignal(0);
  /** How many of `shown` are recent ones, marked as such. */
  const [recentCount, setRecentCount] = createSignal(0);
  let palette!: HTMLDivElement;
  let input!: HTMLInputElement;
  let list!: HTMLUListElement;
  let marker!: HTMLLIElement;
  let focusedBefore: HTMLElement | undefined;
  let latest = 0;

  createEffect(() => {
    if (!props.open) return;
    const commands = props.commands();
    const query = text();
    const turn = ++latest;
    const show = (found: Command[], recents = 0) => {
      if (turn !== latest) return;
      setShown(found);
      setRecentCount(recents);
      setActive(0);
    };
    if (!query) {
      const { first, rest } = props.scope ? { first: [], rest: commands } : recentFirst(commands, recent());
      return show([...first, ...byGroup(rest)], first.length);
    }
    const said = props.words?.(query) ?? [];
    const names = commands.map((command) => command.label);
    rankNames(query, names)
      .then((order) => show([...said, ...order.map((index) => commands[index])]))
      .catch(console.error);
  });

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) {
          focusedBefore = document.activeElement as HTMLElement;
          input.focus();
        } else {
          setText("");
          if (focusedBefore?.isConnected) focusedBefore.focus();
          else props.focusList();
        }
      },
      { defer: true },
    ),
  );

  function onPointerDown(event: PointerEvent) {
    if (props.open && !palette.contains(event.target as Node)) props.onClose();
  }

  onMount(() => window.addEventListener("pointerdown", onPointerDown, true));
  onCleanup(() => window.removeEventListener("pointerdown", onPointerDown, true));

  function move(step: number) {
    const count = shown().length;
    if (!count) return;
    const next = (active() + step + count) % count;
    setActive(next);
    options()[next]?.scrollIntoView({ block: "nearest" });
  }

  const options = () => list.querySelectorAll<HTMLElement>(".palette-option");

  /** The heading over a row, before anything is typed: the rows run lately, then one per group. */
  function heading(index: number) {
    if (text()) return undefined;
    const recents = recentCount();
    if (index < recents) return index === 0 ? "Recent" : undefined;
    const group = shown()[index].group;
    return index === recents || shown()[index - 1].group !== group ? (group ?? "More") : undefined;
  }

  // One highlight glides from row to row, instead of each row lighting up on its own.
  createEffect(() => {
    const at = active();
    shown();
    queueMicrotask(() => {
      const option = options()[at];
      marker.hidden = !option;
      if (option) marker.style.transform = `translateY(${option.offsetTop}px)`;
    });
  });

  /** Closing first gives the focus back, so a command can move it on from there. */
  function choose(command: Command | undefined) {
    if (!command) return;
    if (!props.scope) setRecent([command.label, ...recent().filter((label) => label !== command.label)].slice(0, MOST_RECENT));
    props.onClose();
    command.run();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (event.key === "Enter") choose(shown()[active()]);
    else if (event.key === "Escape") props.onClose();
    else return;
    event.preventDefault();
  }

  return (
    <div
      ref={palette}
      class="palette"
      classList={{ "palette-open": props.open }}
      role="dialog"
      aria-label={props.scope?.label ?? "Command palette"}
    >
      <input
        ref={input}
        class="palette-input"
        role="combobox"
        aria-label="Command"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={shown().length ? optionId(active()) : undefined}
        placeholder={props.scope?.placeholder ?? "Type a command, or sort by, group by, tag, select, search…"}
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        // A list that arrives behind this takes the focus for itself.
        onBlur={() => setTimeout(() => props.open && input.focus())}
      />
      <ul ref={list} id="palette-list" class="palette-list" role="listbox" aria-label="Commands">
        <li ref={marker} class="palette-marker" role="presentation" hidden />
        <For each={shown()} fallback={<li class="palette-empty">No matches.</li>}>
          {(command, index) => (
            <>
            <Show when={heading(index())}>
              {(name) => (
                <li class="palette-heading" role="presentation">
                  {name()}
                </li>
              )}
            </Show>
            <li
              id={optionId(index())}
              class="palette-option"
              role="option"
              aria-selected={index() === active()}
              onPointerMove={() => setActive(index())}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(command)}
            >
              <span class="palette-label">
                <span class="palette-icon" aria-hidden="true">
                  {command.icon}
                </span>
                <span class="palette-name">{command.label}</span>
              </span>
              <span class="palette-keys">
                <Show when={text() && command.group}>
                  <span class="palette-group">{command.group}</span>
                </Show>
                {command.keys}
              </span>
            </li>
            </>
          )}
        </For>
      </ul>
    </div>
  );
}
