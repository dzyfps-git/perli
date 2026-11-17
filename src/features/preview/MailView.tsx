import { createSignal, For, Show } from "solid-js";
import { filetimeToMs, type Mail } from "../../api";
import { formatSize } from "../../ui/format";

export interface MailViewProps {
  mail: Mail;
  /** Saves every attachment beside the mail, or with `choose` in a folder the user picks. True once saved. */
  save: (choose: boolean) => Promise<boolean>;
}

/** The part of a name after its last dot, as a small badge on the attachment. */
const extension = (name: string) => (name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "");

/** A mail saved as a file: its subject, who sent it to whom and when, its attachments and its text. */
export function MailView(props: MailViewProps) {
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal<string>();
  const when = () =>
    props.mail.date ? new Date(filetimeToMs(props.mail.date)).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }) : "";
  const total = () => props.mail.attachments.reduce((sum, attachment) => sum + attachment.size, 0);

  async function save(choose: boolean) {
    if (saving()) return;
    setSaving(true);
    setSaved(undefined);
    try {
      if (await props.save(choose)) setSaved(choose ? "Saved" : "Saved beside the mail");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="mail-view">
      <header class="mail-head">
        <h2 class="mail-subject">{props.mail.subject || "(No subject)"}</h2>
        <dl class="mail-who">
          <Show when={props.mail.from}>
            <dt>From</dt>
            <dd>{props.mail.from}</dd>
          </Show>
          <Show when={props.mail.to}>
            <dt>To</dt>
            <dd>{props.mail.to}</dd>
          </Show>
          <Show when={props.mail.cc}>
            <dt>Cc</dt>
            <dd>{props.mail.cc}</dd>
          </Show>
          <Show when={when()}>
            <dt>Sent</dt>
            <dd>{when()}</dd>
          </Show>
        </dl>
      </header>
      <Show when={props.mail.attachments.length > 0}>
        <section class="mail-attachments" aria-label="Attachments">
          <p class="mail-attachments-head">
            {props.mail.attachments.length === 1 ? "1 attachment" : `${props.mail.attachments.length} attachments`}, {formatSize(total())}
          </p>
          <ul class="mail-attachment-list">
            <For each={props.mail.attachments}>
              {(attachment, at) => (
                <li class="mail-attachment" style={{ "--at": at() }}>
                  <span class="mail-attachment-type" aria-hidden="true">
                    {extension(attachment.name)}
                  </span>
                  <span class="mail-attachment-name">{attachment.name}</span>
                  <small class="mail-attachment-size">{formatSize(attachment.size)}</small>
                </li>
              )}
            </For>
          </ul>
          <div class="mail-attachment-actions">
            <button class="preview-chip" disabled={saving()} onClick={() => void save(false)}>
              Save attachments
            </button>
            <button class="preview-chip" disabled={saving()} onClick={() => void save(true)}>
              Save to…
            </button>
            <Show when={saved()}>
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
        {props.mail.body || <span class="mail-empty">This mail has no text.</span>}
      </div>
    </div>
  );
}
