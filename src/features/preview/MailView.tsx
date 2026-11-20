import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { filetimeToMs, mailAttachment, openFile, readMail, startDragPaths, type Mail } from "../../api";
import { formatSize } from "../../ui/format";

export interface MailViewProps {
  mail: Mail;
  /** The mail's file, which its attachments are read from. */
  path: string;
  /**
   * Saves attachments of the mail at `from` beside the mail first shown, or with `choose` in a folder
   * the user picks: every one, or with `only` the one at that place. True once saved.
   */
  save: (from: string, choose: boolean, only?: number) => Promise<boolean>;
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
}

const ICON_BACK = "";
/** A press on an attachment that moves this far drags it out. */
const DRAG_PX = 6;
/** Attachments that are mails open here, over the mail they came in. */
const MAILS = /\.(eml|msg)$/i;

/** The part of a name after its last dot, as a small badge on the attachment. */
const extension = (name: string) => (name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "");
const subject = (mail: Mail) => mail.subject || "(No subject)";

/**
 * A mail saved as a file: its subject, who sent it to whom and when, its attachments and its text.
 * An attachment opens, saves or drags out on its own, and a mail attached opens here with a way back.
 */
export function MailView(props: MailViewProps) {
  /** Mails opened from attachments, each over the one it came in. */
  const [opened, setOpened] = createSignal<{ mail: Mail; path: string }[]>([]);
  const shown = createMemo(() => opened().at(-1) ?? { mail: props.mail, path: props.path });
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<string>();
  const when = () =>
    shown().mail.date ? new Date(filetimeToMs(shown().mail.date)).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }) : "";
  const total = () => shown().mail.attachments.reduce((sum, attachment) => sum + attachment.size, 0);

  /** One thing at a time; what it says, or what went wrong, shows beside the buttons. */
  async function act(work: () => Promise<string | undefined>) {
    if (busy()) return;
    setBusy(true);
    setNote(undefined);
    try {
      setNote(await work());
    } catch (reason) {
      setNote(String(reason));
    } finally {
      setBusy(false);
    }
  }

  const save = (choose: boolean, only?: number) =>
    act(async () => ((await props.save(shown().path, choose, only)) ? (choose ? "Saved" : "Saved beside the mail") : undefined));

  const open = (at: number) =>
    act(async () => {
      const { mail, path } = shown();
      const name = mail.attachments[at].name;
      const file = await mailAttachment(path, at);
      if (!MAILS.test(name)) {
        await openFile(file);
        return `Opened ${name}`;
      }
      setOpened([...opened(), { mail: await readMail(file), path: file }]);
      return undefined;
    });

  function back() {
    setOpened(opened().slice(0, -1));
    setNote(undefined);
  }

  props.keys((event) => {
    if (opened().length === 0 || !(event.key === "Backspace" || (event.altKey && event.key === "ArrowLeft"))) return false;
    back();
    return true;
  });
  onCleanup(() => props.keys(undefined));

  /** A press on an attachment that moves drags it out, the way a row is dragged out of the list. */
  function onAttachmentDown(event: PointerEvent, at: number) {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    const [x, y] = [event.clientX, event.clientY];
    const move = (next: PointerEvent) => {
      if (Math.hypot(next.clientX - x, next.clientY - y) < DRAG_PX) return;
      done();
      mailAttachment(shown().path, at)
        .then((file) => startDragPaths([file]))
        .catch((reason) => setNote(String(reason)));
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
  }

  return (
    <Show when={shown()} keyed>
      {(page) => (
        <div class="mail-view" classList={{ "mail-inner": opened().length > 0 }}>
          <Show when={opened().length > 0}>
            <button class="mail-back" aria-keyshortcuts="Backspace Alt+ArrowLeft" data-tip="Backspace or Alt+Left" onClick={back}>
              <span class="mail-back-icon" aria-hidden="true">
                {ICON_BACK}
              </span>
              Back to {subject(opened().at(-2)?.mail ?? props.mail)}
            </button>
          </Show>
          <header class="mail-head">
            <h2 class="mail-subject">{subject(page.mail)}</h2>
            <dl class="mail-who">
              <Show when={page.mail.from}>
                <dt>From</dt>
                <dd>{page.mail.from}</dd>
              </Show>
              <Show when={page.mail.to}>
                <dt>To</dt>
                <dd>{page.mail.to}</dd>
              </Show>
              <Show when={page.mail.cc}>
                <dt>Cc</dt>
                <dd>{page.mail.cc}</dd>
              </Show>
              <Show when={when()}>
                <dt>Sent</dt>
                <dd>{when()}</dd>
              </Show>
            </dl>
          </header>
          <Show when={page.mail.attachments.length > 0}>
            <section class="mail-attachments" aria-label="Attachments">
              <p class="mail-attachments-head">
                {page.mail.attachments.length === 1 ? "1 attachment" : `${page.mail.attachments.length} attachments`}, {formatSize(total())}
              </p>
              <ul class="mail-attachment-list">
                <For each={page.mail.attachments}>
                  {(attachment, at) => (
                    <li
                      class="mail-attachment"
                      style={{ "--at": at() }}
                      data-tip="Double-click to open, or drag into a folder"
                      onPointerDown={(event) => onAttachmentDown(event, at())}
                      onDblClick={(event) => !(event.target as Element).closest("button") && void open(at())}
                    >
                      <span class="mail-attachment-type" aria-hidden="true">
                        {extension(attachment.name)}
                      </span>
                      <span class="mail-attachment-name">{attachment.name}</span>
                      <small class="mail-attachment-size">{formatSize(attachment.size)}</small>
                      <span class="mail-attachment-buttons">
                        <button
                          class="mail-attachment-button"
                          disabled={busy()}
                          aria-label={`Open ${attachment.name}`}
                          data-tip={MAILS.test(attachment.name) ? "Open this mail here" : "Open in its app"}
                          onClick={() => void open(at())}
                        >
                          Open
                        </button>
                        <button
                          class="mail-attachment-button"
                          disabled={busy()}
                          aria-label={`Save ${attachment.name}`}
                          data-tip="Save beside the mail"
                          onClick={() => void save(false, at())}
                        >
                          Save
                        </button>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
              <div class="mail-attachment-actions">
                <button class="preview-chip" disabled={busy()} onClick={() => void save(false)}>
                  Save attachments
                </button>
                <button class="preview-chip" disabled={busy()} onClick={() => void save(true)}>
                  Save to…
                </button>
                <Show when={note()}>
                  {(text) => (
                    <span class="mail-saved" role="status">
                      {text()}
                    </span>
                  )}
                </Show>
              </div>
            </section>
          </Show>
          <div class="mail-body" tabindex="0">
            {page.mail.body || <span class="mail-empty">This mail has no text.</span>}
          </div>
        </div>
      )}
    </Show>
  );
}
