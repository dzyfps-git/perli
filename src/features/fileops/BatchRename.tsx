import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { checkRenames, rowFacts, type Selection } from "../../api";
import { finder, renamed, START_RULES, type LetterCase, type RenameRules } from "./renameRules";
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

/** Shows every new name before anything happens, and only goes ahead when all of them work. */
export function BatchRename(props: { request: RenameRequest; onClose: () => void }) {
  const [rows, setRows] = createSignal<[string, boolean][]>([]);
  const [rules, setRules] = createSignal(START_RULES);
  const [problems, setProblems] = createSignal<(string | null)[]>([]);
  const [checked, setChecked] = createSignal(false);
  const [failure, setFailure] = createSignal<string>();
  let dialog!: HTMLDialogElement;
  let find!: HTMLInputElement;
  let timer: number | undefined;
  let latest = 0;

  const change = (part: Partial<RenameRules>) => setRules({ ...rules(), ...part });

  /** Undefined while the pattern makes no sense. */
  const names = createMemo(() => {
    try {
      const search = finder(rules());
      return rows().map(([name, isDir], index) => renamed(name, isDir, index, rules(), search));
    } catch {
      return undefined;
    }
  });

  const changes = () => (names() ?? []).filter((name, index) => name !== rows()[index][0]).length;
  const firstProblem = () => problems().find((problem) => problem !== null);
  const ready = () => checked() && !failure() && !firstProblem() && changes() > 0;

  function summary() {
    if (failure()) return failure();
    if (!names()) return "This regular expression isn't valid.";
    const bad = problems().filter((problem) => problem !== null).length;
    if (bad > 0) return `${bad.toLocaleString()} can't be renamed: ${firstProblem()}`;
    return changes() === 0 ? "Nothing changes yet." : `${changes().toLocaleString()} of ${rows().length.toLocaleString()} change.`;
  }

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
    dialog.close();
    props.request.confirm(wanted);
  }

  onMount(() => {
    dialog.showModal();
    find.focus();
    rowFacts(props.request.selection)
      .then(setRows)
      .catch((reason) => setFailure(String(reason)));
  });
  onCleanup(() => window.clearTimeout(timer));

  const Text = (field: { label: string; rule: "find" | "replace" | "prefix" | "suffix"; ref?: HTMLInputElement }) => (
    <label class="rename-field">
      {field.label}
      <input
        ref={field.ref}
        spellcheck={false}
        value={rules()[field.rule]}
        onInput={(event) => change({ [field.rule]: event.currentTarget.value })}
      />
    </label>
  );

  const Count = (field: { label: string; rule: "start" | "digits"; least: number }) => (
    <label class="rename-field">
      {field.label}
      <input
        type="number"
        min={field.least}
        value={rules()[field.rule]}
        onInput={(event) => {
          const value = event.currentTarget.valueAsNumber;
          if (Number.isInteger(value) && value >= field.least) change({ [field.rule]: value });
        }}
      />
    </label>
  );

  const Check = (field: { label: string; rule: "regex" | "matchCase" | "numbered" | "includeExtension" }) => (
    <label class="job-all">
      <input
        type="checkbox"
        checked={rules()[field.rule]}
        onChange={(event) => change({ [field.rule]: event.currentTarget.checked })}
      />
      {field.label}
    </label>
  );

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
      <Show when={rules().numbered}>
        <div class="rename-fields">
          <Count label="Start at" rule="start" least={0} />
          <Count label="Digits" rule="digits" least={1} />
        </div>
      </Show>
      <ul class="rename-preview">
        <For each={rows().slice(0, PREVIEW_ROWS)}>
          {([name], index) => (
            <li>
              <span class="rename-old">{name}</span>
              <span classList={{ "rename-bad": !!problems()[index()] }}>{names()?.[index()] ?? name}</span>
            </li>
          )}
        </For>
      </ul>
      <p class="confirm-summary">{summary()}</p>
      <div class="confirm-buttons">
        <button class="job-choice" onClick={() => dialog.close()}>
          Cancel
        </button>
        <button class="job-choice" disabled={!ready()} onClick={confirm}>
          Rename
        </button>
      </div>
    </dialog>
  );
}
