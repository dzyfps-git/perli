import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { checkRenames, renameFacts, rowFacts, type Selection } from "../../api";
import { NumberField } from "../../ui/Controls";
import { openSheet } from "../../ui/sheet";
import { saved, stored } from "../filelist/prefs";
import {
  changedPart,
  counts,
  factsNeeded,
  finder,
  moved,
  renamed,
  START_RULES,
  TOKENS,
  typedNames,
  type LetterCase,
  type NameFacts,
  type RenameRules,
} from "./renameRules";
import "../settings/settings.css";
import "./fileops.css";

export interface RenameRequest {
  selection: Selection;
  /** `names` line up with the selected rows. */
  confirm: (names: string[]) => void;
}

const CHECK_DELAY_MS = 150;
/** The whole selection is checked. A longer preview would only be slower to scroll past. */
const PREVIEW_ROWS = 200;
const LETTER_CASES: { value: LetterCase; label: string }[] = [
  { value: "same", label: "Same" },
  { value: "lower", label: "lower" },
  { value: "upper", label: "UPPER" },
  { value: "title", label: "Title" },
];
const ICON_GRIP = "";
const ICON_CLOSE = "";
/** How near the preview's edge a dragged row starts it scrolling. */
const EDGE_PX = 16;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

interface Preset {
  name: string;
  rules: RenameRules;
}

function cleanPresets(value: unknown): Preset[] {
  if (!Array.isArray(value)) return [];
  const good = value.filter((item) => typeof item?.name === "string" && typeof item?.rules === "object" && item.rules);
  return good.map((item) => ({ name: item.name, rules: { ...START_RULES, ...item.rules } }));
}

const [presets, setPresets] = stored("rename-presets", cleanPresets(saved("rename-presets")));
const sameRules = (a: RenameRules, b: RenameRules) => JSON.stringify(a) === JSON.stringify(b);

type TextRule = "find" | "replace" | "prefix" | "suffix";

/** Shows every new name before anything happens, and only goes ahead when all of them work. */
export function BatchRename(props: { request: RenameRequest; onClose: () => void }) {
  const [rows, setRows] = createSignal<[string, boolean][]>([]);
  const [rules, setRules] = createSignal(START_RULES);
  /** The rows in numbering order, by their place in the selection. */
  const [order, setOrder] = createSignal<number[]>([]);
  const [facts, setFacts] = createSignal<{ deep: boolean; rows: NameFacts[] }>();
  /** Typed names, one to a line, which stand in for the rules while set. */
  const [typed, setTyped] = createSignal<string>();
  const [naming, setNaming] = createSignal<string>();
  const [dragging, setDragging] = createSignal<number>();
  const [problems, setProblems] = createSignal<(string | null)[]>([]);
  const [checked, setChecked] = createSignal(false);
  const [failure, setFailure] = createSignal<string>();
  let dialog!: HTMLDialogElement;
  let close!: ReturnType<typeof openSheet>;
  let find!: HTMLInputElement;
  let preview!: HTMLUListElement;
  /** Where a token chip puts its token: the last text box the user was in. */
  let lastText: { input: HTMLInputElement; rule: TextRule } | undefined;
  let timer: number | undefined;
  let latest = 0;
  /** The facts already asked for: none, the quick ones, or the files' own too. */
  let asked: "none" | "quick" | "deep" = "none";

  const change = (part: Partial<RenameRules>) => setRules({ ...rules(), ...part });
  const factsReady = () => {
    const need = factsNeeded(rules());
    return need === "none" || (!!facts() && (need === "quick" || facts()!.deep));
  };

  /** Undefined while the pattern makes no sense, or typed names don't line up with the rows. */
  const names = createMemo(() => {
    const text = typed();
    if (text !== undefined) return typedNames(text, order());
    try {
      const search = finder(rules());
      const place: number[] = [];
      order().forEach((row, at) => (place[row] = at));
      const known = factsReady() ? facts()?.rows : undefined;
      return rows().map(([name, isDir], row) => renamed(name, isDir, place[row] ?? row, rules(), search, known?.[row]));
    } catch {
      return undefined;
    }
  });

  const changes = () => (names() ?? []).filter((name, index) => name !== rows()[index][0]).length;
  const firstProblem = () => problems().find((problem) => problem !== null);
  const ready = () => checked() && factsReady() && !failure() && !firstProblem() && changes() > 0;
  const numbering = () => typed() === undefined && counts(rules());

  function summary() {
    if (failure()) return failure();
    if (!names()) {
      if (typed() === undefined) return "This regular expression isn't valid.";
      const lines = typed()!.replace(/\r?\n$/, "").split(/\r?\n/).length;
      return `${lines.toLocaleString()} names for ${rows().length.toLocaleString()} items. Give each item one line.`;
    }
    if (!factsReady()) return "Reading the files…";
    const bad = problems().filter((problem) => problem !== null).length;
    if (bad > 0) return `${bad.toLocaleString()} can't be renamed: ${firstProblem()}`;
    return changes() === 0 ? "Nothing changes yet." : `${changes().toLocaleString()} of ${rows().length.toLocaleString()} change.`;
  }

  // The tokens that need facts read them once, and the slower ones only when used.
  createEffect(() => {
    const need = factsNeeded(rules());
    if (need === "none" || rows().length === 0 || asked === "deep" || asked === need) return;
    asked = need;
    renameFacts(props.request.selection, need === "deep")
      .then((found) => setFacts({ deep: need === "deep", rows: found }))
      .catch((reason) => setFailure(String(reason)));
  });

  // An older answer must not cover a newer one, so each check knows its turn.
  createEffect(() => {
    const wanted = names();
    const turn = ++latest;
    setChecked(false);
    window.clearTimeout(timer);
    if (!wanted?.length) return;
    timer = window.setTimeout(async () => {
      try {
        const found = await checkRenames(props.request.selection, wanted);
        if (turn !== latest) return;
        setProblems(found);
        setChecked(true);
      } catch (reason) {
        if (turn === latest) setFailure(String(reason));
      }
    }, CHECK_DELAY_MS);
  });

  function confirm() {
    const wanted = names();
    if (!ready() || !wanted) return;
    close();
    props.request.confirm(wanted);
  }

  /** Text mode starts from the names the rules make now, in the order shown. */
  function toggleText() {
    if (typed() !== undefined) return setTyped(undefined);
    const now = names() ?? rows().map(([name]) => name);
    setTyped(order().map((row) => now[row]).join("\n"));
  }

  function insertToken(token: string) {
    const target = lastText ?? { input: find, rule: "find" as const };
    const { input, rule } = target;
    input.setRangeText(token, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, "end");
    change({ [rule]: input.value });
    input.focus();
  }

  function savePreset() {
    const name = naming()?.trim();
    if (!name) return setNaming(undefined);
    setPresets([...presets().filter((preset) => preset.name !== name), { name, rules: rules() }]);
    setNaming(undefined);
  }

  /** Moves the row at `at` in the order with the pointer, a whole row at a time. */
  function grab(event: PointerEvent, at: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const height = handle.closest("li")!.offsetHeight || 1;
    const shown = Math.min(order().length, PREVIEW_ROWS);
    let from = at;
    const origin = event.clientY + preview.scrollTop;
    setDragging(order()[at]);
    const move = (moving: PointerEvent) => {
      const box = preview.getBoundingClientRect();
      if (moving.clientY < box.top + EDGE_PX) preview.scrollTop -= height / 2;
      else if (moving.clientY > box.bottom - EDGE_PX) preview.scrollTop += height / 2;
      const to = Math.max(0, Math.min(shown - 1, at + Math.round((moving.clientY + preview.scrollTop - origin) / height)));
      if (to === from) return;
      setOrder(moved(order(), from, to));
      from = to;
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      setDragging(undefined);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop, { once: true });
    handle.addEventListener("pointercancel", stop, { once: true });
  }

  function nudge(event: KeyboardEvent, at: number) {
    const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    const to = at + step;
    if (!step || to < 0 || to >= Math.min(order().length, PREVIEW_ROWS)) return;
    event.preventDefault();
    setOrder(moved(order(), at, to));
  }

  onMount(() => {
    close = openSheet(dialog);
    find.focus();
    rowFacts(props.request.selection)
      .then((found) => {
        setRows(found);
        setOrder(found.map((_, row) => row));
      })
      .catch((reason) => setFailure(String(reason)));
  });
  onCleanup(() => window.clearTimeout(timer));

  const Text = (field: { label: string; rule: TextRule; ref?: HTMLInputElement }) => (
    <label class="rename-field">
      {field.label}
      <input
        ref={field.ref}
        spellcheck={false}
        value={rules()[field.rule]}
        onFocus={(event) => (lastText = { input: event.currentTarget, rule: field.rule })}
        onInput={(event) => change({ [field.rule]: event.currentTarget.value })}
      />
    </label>
  );

  const Count = (field: { label: string; rule: "start" | "digits" | "dropFirst" | "dropLast"; least: number }) => (
    <label class="rename-field">
      {field.label}
      <NumberField value={rules()[field.rule]} least={field.least} onChange={(value) => change({ [field.rule]: value })} />
    </label>
  );

  const Check = (field: { label: string; rule: "regex" | "matchCase" | "numbered" | "includeExtension" | "trim" }) => (
    <label class="job-all">
      <input
        type="checkbox"
        checked={rules()[field.rule]}
        onChange={(event) => change({ [field.rule]: event.currentTarget.checked })}
      />
      {field.label}
    </label>
  );

  /** One preview row. The changed part of the new name settles in each time it changes. */
  const Row = (row: { index: number; at: () => number }) => {
    const name = () => rows()[row.index][0];
    const next = () => names()?.[row.index] ?? name();
    const part = () => changedPart(name(), next());
    const problem = () => problems()[row.index];
    let added!: HTMLModElement;
    createEffect(
      on(next, () => {
        if (reducedMotion.matches || !added.textContent) return;
        added.animate(
          [
            { opacity: 0.2, filter: "blur(3px)", translate: "0 -3px" },
            { opacity: 1, filter: "blur(0)", translate: "0 0" },
          ],
          { duration: 220, easing: "ease-out" },
        );
      }, { defer: true }),
    );
    return (
      <li data-dragging={dragging() === row.index ? "" : undefined}>
        <Show when={numbering()}>
          <button
            class="rename-grip"
            aria-label={`Move ${name()} in the numbering order`}
            onPointerDown={(event) => grab(event, row.at())}
            onKeyDown={(event) => nudge(event, row.at())}
          >
            {ICON_GRIP}
          </button>
        </Show>
        <span class="rename-old">
          {name().slice(0, part().start)}
          <del class="rename-gone">{name().slice(part().start, part().oldEnd)}</del>
          {name().slice(part().oldEnd)}
        </span>
        <span classList={{ "rename-bad": !!problem() }}>
          {next().slice(0, part().start)}
          <ins ref={added} class="rename-new">
            {next().slice(part().start, part().newEnd)}
          </ins>
          {next().slice(part().newEnd)}
        </span>
        <Show when={problem()}>
          <span class="rename-why">{problem()}</span>
        </Show>
      </li>
    );
  };

  return (
    <dialog
      ref={dialog}
      class="settings confirm batch-rename"
      aria-label="Rename items"
      onClose={props.onClose}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) confirm();
      }}
    >
      <h2>Rename {rows().length.toLocaleString()} items</h2>
      <div class="rename-presets" role="group" aria-label="Presets">
        <For each={presets()}>
          {(preset) => (
            <span class="rename-preset" data-on={sameRules(preset.rules, rules()) ? "" : undefined}>
              <button class="rename-preset-use" onClick={() => setRules(preset.rules)}>
                {preset.name}
              </button>
              <button
                class="rename-preset-forget"
                aria-label={`Forget the preset ${preset.name}`}
                onClick={() => setPresets(presets().filter((other) => other !== preset))}
              >
                {ICON_CLOSE}
              </button>
            </span>
          )}
        </For>
        <Show
          when={naming() !== undefined}
          fallback={
            <button class="rename-chip" disabled={typed() !== undefined} onClick={() => setNaming("")}>
              Save as preset
            </button>
          }
        >
          <input
            class="rename-preset-name"
            aria-label="Preset name"
            placeholder="Preset name"
            ref={(input) => queueMicrotask(() => input.focus())}
            value={naming()}
            onInput={(event) => setNaming(event.currentTarget.value)}
            onBlur={savePreset}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") setNaming(undefined);
              else savePreset();
            }}
          />
        </Show>
        <button class="rename-chip rename-text-toggle" aria-pressed={typed() !== undefined} onClick={toggleText}>
          Edit as text
        </button>
      </div>
      <Show
        when={typed() === undefined}
        fallback={
          <label class="rename-field rename-typed">
            One name a line, in the order shown below
            <textarea
              spellcheck={false}
              rows={Math.min(Math.max(rows().length, 3), 12)}
              value={typed()}
              ref={(area) => queueMicrotask(() => area.focus())}
              onInput={(event) => setTyped(event.currentTarget.value)}
            />
          </label>
        }
      >
        <div class="rename-fields">
          <Text label="Find" rule="find" ref={find} />
          <Text label="Replace with" rule="replace" />
        </div>
        <div class="rename-options">
          <Check label="Regular expression" rule="regex" />
          <Check label="Match case" rule="matchCase" />
          <Check label="Include extension" rule="includeExtension" />
        </div>
        <div class="rename-fields">
          <Text label="Add before" rule="prefix" />
          <Text label="Add after" rule="suffix" />
        </div>
        <div class="rename-tokens" role="group" aria-label="Insert a token">
          <For each={TOKENS}>
            {({ token, label }) => (
              <button
                class="rename-chip"
                aria-label={`Insert ${label}, ${token}`}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => insertToken(token)}
              >
                {label}
              </button>
            )}
          </For>
        </div>
        <div class="rename-fields rename-fields-three">
          <Count label="Remove first" rule="dropFirst" least={0} />
          <Count label="Remove last" rule="dropLast" least={0} />
          <div class="rename-options rename-tidy">
            <Check label="Tidy spaces" rule="trim" />
          </div>
        </div>
        <div class="rename-options">
          <For each={LETTER_CASES}>
            {({ value, label }) => (
              <button
                class="job-choice rename-case"
                aria-pressed={rules().letterCase === value}
                onClick={() => change({ letterCase: value })}
              >
                {label}
              </button>
            )}
          </For>
          <Check label="Number them" rule="numbered" />
        </div>
        <Show when={counts(rules())}>
          <div class="rename-fields rename-fields-three">
            <Count label="Start at" rule="start" least={0} />
            <Count label="Digits" rule="digits" least={1} />
            <div class="rename-options rename-tidy">
              <button
                class="rename-chip"
                disabled={order().every((row, at) => row === at)}
                onClick={() => setOrder(rows().map((_, row) => row))}
              >
                Reset order
              </button>
            </div>
          </div>
        </Show>
      </Show>
      <ul ref={preview} class="rename-preview" data-numbering={numbering() ? "" : undefined}>
        <For each={order().slice(0, PREVIEW_ROWS)}>{(row, at) => <Row index={row} at={at} />}</For>
      </ul>
      <Show when={numbering()}>
        <p class="settings-note rename-order-note">Drag a row by its handle, or use the arrow keys on it, to change the numbering order.</p>
      </Show>
      <p class="confirm-summary">{summary()}</p>
      <div class="confirm-buttons">
        <button class="job-choice" onClick={() => close()}>
          Cancel
        </button>
        <button class="job-choice" disabled={!ready()} onClick={confirm}>
          Rename
        </button>
      </div>
    </dialog>
  );
}
