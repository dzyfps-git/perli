import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { indexStatus, journalStatus, rebuildIndex, setJournal, type IndexStatus, type JournalStatus } from "../../api";
import { Switch } from "../../ui/Controls";
import { ago } from "../../ui/dates";
import { formatSize } from "../../ui/format";
import { pick } from "../dialogs/Picker";
import {
  indexBattery,
  indexNetwork,
  indexOn,
  indexPaused,
  indexSkip,
  setIndexBattery,
  setIndexNetwork,
  setIndexOn,
  setIndexPaused,
  setIndexSkip,
} from "./indexPrefs";
import { withSkipped } from "./skipList";

const LOOK_MS = 1500;
const count = new Intl.NumberFormat();

/** What the index is doing, in a few words. */
function said(status: IndexStatus | undefined) {
  if (!status || status.state === "waiting") return "Getting ready…";
  switch (status.state) {
    case "walking":
      return `Listing files… ${count.format(status.listed)} so far`;
    case "paused":
      return "Paused. Searches walk the folders until it goes on.";
    case "battery":
      return "Waiting until the PC is plugged in";
    default:
      return `${count.format(status.files)} files and folders listed`;
  }
}

/** The whole-PC index: on or off, how it is doing, and what it leaves out. How it is doing is
 *  asked only while Settings is open. */
export function IndexSettings(props: { open: boolean }) {
  const [status, setStatus] = createSignal<IndexStatus>();
  const [asked, setAsked] = createSignal(false);
  const look = () => indexStatus().then(setStatus).catch(console.error);
  createEffect(() => {
    if (!props.open || !indexOn()) return;
    look();
    const timer = setInterval(look, LOOK_MS);
    onCleanup(() => clearInterval(timer));
  });

  async function leaveOut() {
    const picked = await pick({ mode: "folder", title: "Leave out of the index", purpose: "folders" });
    if (picked) setIndexSkip(withSkipped(indexSkip(), picked.path));
  }

  // The journal helper: read when Settings opens, and again after each change.
  const [journal, setJournalShown] = createSignal<JournalStatus>();
  const [journalBusy, setJournalBusy] = createSignal(false);
  const [journalFailure, setJournalFailure] = createSignal<string>();
  const readJournal = () => journalStatus().then(setJournalShown).catch(console.error);
  createEffect(() => props.open && indexOn() && void readJournal());
  async function changeJournal(on: boolean) {
    setJournalBusy(true);
    setJournalFailure(undefined);
    try {
      await setJournal(on);
    } catch (reason) {
      setJournalFailure(String(reason));
    } finally {
      await readJournal();
      setJournalBusy(false);
    }
  }

  async function rebuild() {
    setAsked(true);
    await rebuildIndex().catch(console.error);
    setTimeout(() => setAsked(false), LOOK_MS * 2);
  }

  return (
    <>
      <Switch
        label="Index every file on this PC"
        note="Searches over a folder, a drive or every drive then answer at once. Perli lists each file's name, size and dates in the background and follows changes as they happen. Turning it off deletes the list."
        checked={indexOn()}
        onChange={setIndexOn}
      />
      <Show when={indexOn()}>
        <div class="settings-chips settings-cache">
          <span class="settings-cache-size" role="status" data-state={status()?.state}>
            {said(status())}
          </span>
          <button class="settings-chip" onClick={() => setIndexPaused(!indexPaused())}>
            {indexPaused() ? "Go on" : "Pause"}
          </button>
          <button class="settings-chip" disabled={asked() || indexPaused()} onClick={() => void rebuild()}>
            Rebuild
          </button>
        </div>
        <Show when={status()?.drives.length || status()?.bytes}>
          <p class="settings-note">
            <Show when={status()?.drives.length}>{`Up to date on ${status()!.drives.map((drive) => drive.replace(/\\$/, "")).join(", ")}. `}</Show>
            <Show when={status()?.walked}>{`Last looked through ${ago(status()!.walked!, Date.now())}. `}</Show>
            {`The list takes ${formatSize(status()?.bytes ?? 0)}.`}
          </p>
        </Show>
        <Show when={journal()?.possible}>
          <Switch
            label="Catch up instantly (asks for admin once)"
            note="When Perli starts, each NTFS drive's change journal says what changed while it was closed, so only that is read again instead of every drive. Windows asks for admin once, to set up a helper in Program Files that only reads the journals."
            checked={!!journal()?.on}
            disabled={journalBusy()}
            onChange={(on) => void changeJournal(on)}
          />
          <Show when={journal()?.old || journalFailure()}>
            <div class="settings-chips">
              <p class="settings-note" role="status" classList={{ "properties-failure": !!journalFailure() }}>
                {journalFailure() ?? "The helper changed with this Perli. Set it up again to keep catching up instantly."}
              </p>
              <Show when={journal()?.old && !journalFailure()}>
                <button class="settings-chip" disabled={journalBusy()} onClick={() => void changeJournal(true)}>
                  Set up again
                </button>
              </Show>
            </div>
          </Show>
        </Show>
        <Switch
          label="Wait while on battery"
          note="Following changes goes on, since it costs next to nothing; listing a drive waits for the plug."
          checked={indexBattery()}
          onChange={setIndexBattery}
        />
        <Switch
          label="Network drives too"
          note="Drives with a letter that are on another PC. They are looked through again every half hour instead of followed."
          checked={indexNetwork()}
          onChange={setIndexNetwork}
        />
        <h4>Left out</h4>
        <ul class="settings-list index-skip" aria-label="Folders left out of the index">
          <For each={indexSkip()} fallback={<li class="settings-note">Nothing. Perli's own folder is always left out.</li>}>
            {(folder) => (
              <li class="index-skip-row">
                <span class="index-skip-path">{folder}</span>
                <button
                  class="settings-chip"
                  aria-label={`Put ${folder} back in the index`}
                  onClick={() => setIndexSkip(indexSkip().filter((kept) => kept !== folder))}
                >
                  Put back
                </button>
              </li>
            )}
          </For>
        </ul>
        <div class="settings-chips">
          <button class="settings-chip" onClick={() => void leaveOut()}>
            Leave out a folder…
          </button>
        </div>
      </Show>
    </>
  );
}
