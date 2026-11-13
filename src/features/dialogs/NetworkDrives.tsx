import { createResource, createSignal, For, onMount, Show } from "solid-js";
import { driveLetters, mapNetworkDrive, unmapDrive } from "../../api";
import { Switch } from "../../ui/Controls";
import { openSheet } from "../../ui/sheet";
import { saved, stored } from "../filelist/prefs";
import { isShare, shareText, withShare } from "./parts";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "./dialogs.css";

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((one) => typeof one === "string") : []);
const [recent, setRecent] = stored<string[]>("recent-shares", strings(saved("recent-shares")));

/**
 * Perli's own Map network drive: a letter, a share, and whether it comes back at sign-in. A name
 * and password, when the server wants them, are asked by Windows and never pass through Perli.
 */
export function MapDrive(props: {
  /** The drive that was mapped, such as `Z:`. */
  onMapped: (letter: string) => void;
  /** Windows' own dialog instead. */
  onWindows: () => void;
  onClose: () => void;
}) {
  const [letters] = createResource(driveLetters);
  const [letter, setLetter] = createSignal<string>();
  const [typed, setTyped] = createSignal("");
  const [remember, setRemember] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string>();
  let dialog!: HTMLDialogElement;
  let input!: HTMLInputElement;
  let close!: ReturnType<typeof openSheet>;

  const share = () => shareText(typed());
  const chosen = () => letter() ?? letters()?.free[0];
  const ready = () => !busy() && !!chosen() && isShare(share());
  const hint = () => {
    if (failure()) return failure();
    if (letters() && letters()!.free.length === 0) return "Every drive letter is taken.";
    if (!typed().trim()) return "Type it as \\\\server\\share. Slashes the other way work too.";
    return isShare(share()) ? `${chosen()} will open ${share()}` : "A share needs a server and a folder: \\\\server\\share";
  };

  async function confirm() {
    if (!ready()) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const [drive, remote] = [chosen()!, share()];
      await mapNetworkDrive(drive, remote, remember());
      // Backing out of Windows' sign-in maps nothing and is no failure, so the drive is looked for.
      const mapped = (await driveLetters()).mapped.some((one) => one.letter === drive);
      if (!mapped) return;
      setRecent(withShare(recent(), remote));
      close(() => props.onMapped(drive));
    } catch (reason) {
      setFailure(String(reason));
    } finally {
      setBusy(false);
    }
  }

  onMount(() => {
    close = openSheet(dialog);
    input.focus();
  });

  return (
    <dialog
      ref={dialog}
      class="settings confirm drive-sheet"
      aria-label="Map network drive"
      onClose={props.onClose}
      onKeyDown={(event) => event.key === "Enter" && event.target === input && confirm()}
    >
      <h2>Map network drive</h2>
      <div class="drive-fields">
        <label class="rename-field">
          Letter
          <select value={chosen()} aria-label="Drive letter" onChange={(event) => setLetter(event.currentTarget.value)}>
            <For each={letters()?.free ?? []}>{(free) => <option value={free}>{free}</option>}</For>
          </select>
        </label>
        <label class="rename-field">
          Share
          <input
            ref={input}
            spellcheck={false}
            placeholder="\\server\share"
            value={typed()}
            onInput={(event) => {
              setTyped(event.currentTarget.value);
              setFailure(undefined);
            }}
            // What was typed is shown the way Windows will get it.
            onBlur={() => share() && setTyped(share())}
          />
        </label>
      </div>
      <p class="drive-hint" classList={{ "properties-failure": !!failure() }} role="status">
        {hint()}
      </p>
      <Show when={recent().length > 0}>
        <div class="drive-recent" role="group" aria-label="Mapped before">
          <For each={recent()}>
            {(known) => (
              <button class="settings-chip" onClick={() => setTyped(known)}>
                {known}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Switch
        label="Reconnect at sign-in"
        note="Windows brings the drive back each time you sign in"
        checked={remember()}
        onChange={setRemember}
      />
      <div class="confirm-buttons properties-buttons">
        <button class="properties-link" onClick={() => close(props.onWindows)}>
          Windows dialog
        </button>
        <span class="properties-said" />
        <button class="job-choice" onClick={() => close()}>
          Cancel
        </button>
        <button class="job-choice drive-confirm" disabled={!ready()} onClick={confirm}>
          {busy() ? "Connecting…" : "Map"}
        </button>
      </div>
    </dialog>
  );
}

/** Perli's own Disconnect network drive: each mapped drive with where it goes. */
export function DisconnectDrive(props: {
  onUnmapped: (letter: string) => void;
  onWindows: () => void;
  onClose: () => void;
}) {
  const [letters, { refetch }] = createResource(driveLetters);
  const [failure, setFailure] = createSignal<string>();
  const [leaving, setLeaving] = createSignal<string>();
  let dialog!: HTMLDialogElement;
  let done!: HTMLButtonElement;
  let close!: ReturnType<typeof openSheet>;

  async function disconnect(letter: string) {
    setFailure(undefined);
    setLeaving(letter);
    try {
      await unmapDrive(letter);
      props.onUnmapped(letter);
      await refetch();
    } catch (reason) {
      setFailure(`${letter} ${String(reason)}`);
    } finally {
      setLeaving(undefined);
    }
  }

  onMount(() => {
    close = openSheet(dialog);
    done.focus();
  });

  return (
    <dialog ref={dialog} class="settings confirm drive-sheet" aria-label="Disconnect network drive" onClose={props.onClose}>
      <h2>Disconnect network drive</h2>
      <div class="drive-list">
        <For
          each={letters()?.mapped ?? []}
          fallback={<p class="app-none">{letters.loading ? "Looking for drives…" : "No network drive is connected."}</p>}
        >
          {(drive) => (
            <div class="drive-row" classList={{ "drive-leaving": leaving() === drive.letter }}>
              <span class="drive-letter">{drive.letter}</span>
              <span class="drive-remote">{drive.remote || "Unknown share"}</span>
              <button class="job-choice" disabled={!!leaving()} onClick={() => disconnect(drive.letter)}>
                Disconnect
              </button>
            </div>
          )}
        </For>
      </div>
      <p class="drive-hint">The share and its files stay where they are. Only the letter goes.</p>
      <Show when={failure()}>
        <p class="properties-failure" role="alert">
          {failure()}
        </p>
      </Show>
      <div class="confirm-buttons properties-buttons">
        <button class="properties-link" onClick={() => close(props.onWindows)}>
          Windows dialog
        </button>
        <span class="properties-said" />
        <button ref={done} class="job-choice" onClick={() => close()}>
          Done
        </button>
      </div>
    </dialog>
  );
}
