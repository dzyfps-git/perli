import { createEffect, createSignal, For, on, onCleanup, onMount } from "solid-js";
import { rankNames } from "../../api";
import "./palette.css";

export interface Command {
  label: string;
  keys?: string;
  run: () => void;
}

const optionId = (index: number) => `palette-option-${index}`;

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
  let palette!: HTMLDivElement;
  let input!: HTMLInputElement;
  let list!: HTMLUListElement;
  let focusedBefore: HTMLElement | undefined;
  let latest = 0;

  createEffect(() => {
    if (!props.open) return;
    const commands = props.commands();
    const query = text();
    const turn = ++latest;
    const show = (found: Command[]) => {
      if (turn !== latest) return;
      setShown(found);
      setActive(0);
    };
    if (!query) return show(commands);
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
    list.children[next].scrollIntoView({ block: "nearest" });
  }

  /** Closing first gives the focus back, so a command can move it on from there. */
  function choose(command: Command | undefined) {
    if (!command) return;
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
              {command.label}
              <span class="palette-keys">{command.keys}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
