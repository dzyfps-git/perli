import { createEffect, createSignal, on, Show } from "solid-js";
import { unlockZip } from "../../api";
import type { FolderView } from "../navigation/folderView";
import { archiveKind, baseName, partNumber } from "../navigation/path";
import { PasswordCard, WRONG_PASSWORD } from "../preview/PasswordCard";

const ICON_ZIP = "";
const ICON_LOCK = "";
const ICON_EXTRACT = "";

/**
 * Says an archive opened as a folder can only be read, and offers what works on all of it:
 * taking it all out, and the password its locked files need.
 */
export function ZipBar(props: { view: FolderView; onExtract: () => void }) {
  const [asking, setAsking] = createSignal<{ wrong?: string }>();
  const name = () => baseName(props.view.archive() ?? "");
  const part = () => partNumber(name());
  // An archive whose very names are locked shows nothing until its password is in, so it asks.
  createEffect(
    on(
      () => props.view.folder(),
      (shown) => {
        if (props.view.locked() && shown?.count === 0 && shown.path === props.view.archive()) setAsking({});
      },
    ),
  );

  async function unlock(password: string) {
    const archive = props.view.archive();
    if (!archive) return;
    try {
      await unlockZip(archive, password);
      setAsking(undefined);
      // Read again so the rows and the bar know the password is in.
      const shown = props.view.folder()?.path;
      if (shown) await props.view.open(shown);
    } catch (reason) {
      setAsking({ wrong: String(reason).includes(WRONG_PASSWORD) ? "That password does not open it. Try again." : String(reason) });
    }
  }

  return (
    <div class="zip-bar" role="toolbar" aria-label={`Inside ${name()}, a ${archiveKind(name())} archive`}>
      <span class="zip-bar-icon" aria-hidden="true">
        {ICON_ZIP}
      </span>
      <span class="zip-bar-name">{name()}</span>
      <Show when={part()}>
        {(number) => (
          <span class="zip-bar-pill zip-bar-part" aria-label="One part of a set. Everything in the set shows, read from its first part">
            Part {number()}
          </span>
        )}
      </Show>
      <span class="zip-bar-pill" aria-label="Files here can be opened and copied out, not changed">
        Read-only
      </span>
      <span class="zip-bar-gap" />
      <Show when={props.view.locked()}>
        <button class="chip zip-bar-button" aria-label="Some files here are under a password" onClick={() => setAsking({})}>
          <span class="zip-bar-glyph" aria-hidden="true">
            {ICON_LOCK}
          </span>
          Enter password
        </button>
      </Show>
      <button class="chip zip-bar-button zip-bar-extract" aria-label={`Take everything out into a folder beside ${name()}`} onClick={() => props.onExtract()}>
        <span class="zip-bar-glyph" aria-hidden="true">
          {ICON_EXTRACT}
        </span>
        Extract all
      </button>
      <Show when={asking()}>
        {(waiting) => (
          <div class="zip-bar-password">
            <PasswordCard
              wrong={waiting().wrong}
              note="Perli keeps it until it closes."
              onTry={(password) => void unlock(password)}
              onCancel={() => {
                setAsking(undefined);
                props.view.list()?.focus();
              }}
            />
          </div>
        )}
      </Show>
    </div>
  );
}
