import { createEffect, createSignal, For, on, onCleanup, onMount } from "solid-js";
import { rankNames } from "../../api";
import { saved, stored } from "../filelist/prefs";
import "./palette.css";

export interface Command {
  label: string;
  keys?: string;
  run: () => void;
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
      const { first, rest } = recentFirst(commands, recent());
      return show([...first, ...rest], first.length);
    }
    const names = commands.map((command) => command.label);
    rankNames(query, names)
      .then((order) => show(order.map((index) => commands[index])))
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
    setRecent([command.label, ...recent().filter((label) => label !== command.label)].slice(0, MOST_RECENT));
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
      aria-label="Command palette"
    >
      <input
        ref={input}
        class="palette-input"
        role="combobox"
        aria-label="Command"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={shown().length ? optionId(active()) : undefined}
        placeholder="Type a command"
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
                {command.label}
                {index() < recentCount() && <span class="palette-recent">Recent</span>}
              </span>
              <span class="palette-keys">{command.keys}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
