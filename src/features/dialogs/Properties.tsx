import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import {
  commonTags,
  driveSpace,
  fetchPictureFile,
  itemFacts,
  measurePaths,
  pathChecksum,
  pathProperties,
  pathUsers,
  setAttributes,
  setTag,
  type ItemFacts,
  type Share,
  type ShellTarget,
} from "../../api";
import { Switch } from "../../ui/Controls";
import { formatSize } from "../../ui/format";
import { openSheet } from "../../ui/sheet";
import { Checksum } from "../preview/Checksum";
import { draw } from "../preview/QuickPreview";
import { refreshTags, tagColor, tags } from "../tags/tags";
import { contents, counted, detailsText, nameOf, parentOf } from "./parts";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "../preview/preview.css";
import "./dialogs.css";

const dates = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const when = (time: number | null) => (time === null ? undefined : dates.format(time));
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const PICTURE_EDGE = 96;
const COUNT_MS = 500;

const ICON_COPY = "";
const ICON_DONE = "";

/** A number that runs up to each new value, so a folder's size is seen arriving. */
function runningTo(target: () => number | undefined) {
  const [shown, setShown] = createSignal(0);
  let frame = 0;
  createEffect(() => {
    const wanted = target();
    if (wanted === undefined) return;
    cancelAnimationFrame(frame);
    if (reducedMotion.matches) return setShown(wanted);
    const [from, started] = [untrack(shown), performance.now()];
    const step = (now: number) => {
      const part = Math.min(1, (now - started) / COUNT_MS);
      setShown(Math.round(from + (wanted - from) * (1 - (1 - part) ** 3)));
      if (part < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  });
  onCleanup(() => cancelAnimationFrame(frame));
  return shown;
}

/**
 * Perli's own Properties: what a file, folder, drive or a whole selection is, how big, when it
 * changed, what opens it and what holds it open. Read-only and hidden change here. Security,
 * sharing and older versions stay with Windows' window, one button away.
 */
export function Properties(props: {
  target: ShellTarget;
  /** Opens the app picker for these files. */
  onPickApp: (paths: string[]) => void;
  /** Windows' own Properties window for the same thing. */
  onWindows: () => void;
  /** After read-only, hidden or a tag changed, so the list can show it. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const [facts, setFacts] = createSignal<ItemFacts>();
  const [failure, setFailure] = createSignal<string>();
  const [copied, setCopied] = createSignal<string>();
  const [common, setCommon] = createSignal<number[]>([]);
  /** A checksum reads the whole file, so it waits until its part is opened. */
  const [moreOpen, setMoreOpen] = createSignal(false);
  let dialog!: HTMLDialogElement;
  let done!: HTMLButtonElement;
  let close!: ReturnType<typeof openSheet>;

  const paths = () => facts()?.paths ?? [];
  const alone = () => paths().length === 1;
  const first = () => paths()[0];
  const isFile = () => alone() && facts()!.files === 1;
  const selection = props.target.kind === "rows" ? props.target.selection : undefined;

  const [picture] = createResource(first, (path) => fetchPictureFile(path, PICTURE_EDGE).catch(() => null));
  const [measured] = createResource(
    () => (facts() && !isFile() ? paths() : undefined),
    (all) => measurePaths(all),
  );
  const [space] = createResource(
    () => (facts()?.isRoot && alone() ? first() : undefined),
    (drive) => driveSpace(drive).catch(() => undefined),
  );
  const [users] = createResource(
    () => (facts() && !facts()!.isRoot ? paths() : undefined),
    (all) => pathUsers(all).catch((): string[] => []),
  );
  const [more] = createResource(
    () => (alone() ? first() : undefined),
    (path) => pathProperties(path).catch((): [string, string, string][] => []),
  );
  const bytes = runningTo(() => measured()?.bytes);
  const items = runningTo(() => measured()?.items);

  const title = () => {
    const found = facts();
    if (!found) return "Properties";
    return alone() ? nameOf(first()) : counted(paths().length, "item", "items");
  };
  const kind = () => {
    const found = facts();
    if (!found) return "";
    if (!alone()) return contents(found.files, found.folders);
    if (found.isRoot) return "Drive";
    return found.folders === 1 ? "Folder" : (found.kind ?? "File");
  };
  const sizeText = () => {
    if (isFile()) return `${formatSize(facts()!.size)} (${facts()!.size.toLocaleString()} bytes)`;
    if (measured.error) return "Couldn't measure";
    if (!measured()) return "Measuring…";
    return `${formatSize(bytes())} in ${counted(items(), "item", "items")}`;
  };
  const usersText = () => {
    const found = users();
    if (!found) return "Checking…";
    return found.length > 0 ? found.join(", ") : "Nothing";
  };

  async function read() {
    try {
      setFacts(await itemFacts(props.target));
      if (selection) {
        await refreshTags();
        // A drive with no file IDs has no tags to show.
        setCommon(await commonTags(selection).catch((): number[] => []));
      }
    } catch (reason) {
      setFailure(String(reason));
    }
  }

  /** `some` turns on, as a mixed checkbox does. */
  async function change(flag: "readOnly" | "hidden", now: Share) {
    const on = now !== "all";
    try {
      await setAttributes(paths(), { [flag]: on });
      setFailure(undefined);
      setFacts({ ...facts()!, [flag]: on ? "all" : "none" });
      props.onChanged();
    } catch (reason) {
      setFailure(String(reason));
    }
  }

  // ponytail: the rows are the ones the sheet opened on. If the folder reloads behind the sheet
  // Windows' answer is "that row is gone", which shows here. Tag by path if that comes up.
  async function toggleTag(id: number) {
    if (!selection) return;
    try {
      const on = !common().includes(id);
      await setTag(selection, id, on);
      setCommon(on ? [...common(), id] : common().filter((tag) => tag !== id));
      setFailure(undefined);
      props.onChanged();
    } catch (reason) {
      setFailure(String(reason));
    }
  }

  function copy(text: string, said: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(said))
      .catch(() => setCopied("Couldn't copy"));
  }

  function copyDetails() {
    const found = facts()!;
    const text = detailsText([
      ["Name", title()],
      ["Kind", kind()],
      ["Place", alone() ? first() : parentOf(first())],
      ["Size", sizeText()],
      ["Created", alone() && when(found.created)],
      ["Modified", alone() && when(found.modified)],
      ["Opened", alone() && when(found.accessed)],
      ["Opens with", isFile() && (found.defaultApp ?? undefined)],
      ...(more() ?? []).map(([, label, value]): [string, string] => [label, value]),
    ]);
    copy(text, "Details copied");
  }

  onMount(() => {
    close = openSheet(dialog);
    done.focus();
    read();
  });

  return (
    <dialog ref={dialog} class="settings confirm properties" aria-label="Properties" onClose={props.onClose}>
      <header class="properties-head">
        <Show when={picture()} keyed fallback={<span class="properties-picture" />}>
          {(thumb) => <canvas ref={(canvas) => draw(canvas, thumb)} class="properties-picture" />}
        </Show>
        <div class="properties-title">
          <h2>{title()}</h2>
          <p class="properties-kind">{kind()}</p>
        </div>
      </header>

      <Show when={facts()} keyed fallback={<p class="confirm-summary">{failure() ?? "Reading…"}</p>}>
        {(found) => (
          <div class="properties-body">
            <dl class="details-facts properties-facts">
              <dt>{alone() ? "Place" : "In"}</dt>
              <dd class="properties-place">
                <span>{alone() ? first() : (parentOf(first()) ?? first())}</span>
                <button
                  class="properties-copy"
                  aria-label={alone() ? "Copy path" : "Copy paths"}
                  onClick={() => copy(paths().join("\n"), alone() ? "Path copied" : "Paths copied")}
                >
                  {copied()?.startsWith("Path") ? ICON_DONE : ICON_COPY}
                </button>
              </dd>
              <Show when={!found.isRoot} fallback={
                <Show when={space()} keyed>
                  {(drive) => (
                    <>
                      <dt>Space</dt>
                      <dd>
                        <span
                          class="properties-space"
                          role="meter"
                          aria-label="Space used"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round((1 - drive.free / drive.total) * 100)}
                          style={{ "--used": `${(1 - drive.free / drive.total) * 100}%` }}
                        />
                        {formatSize(drive.free)} free of {formatSize(drive.total)}
                      </dd>
                    </>
                  )}
                </Show>
              }>
                <dt>Size</dt>
                <dd classList={{ "hash-working": !isFile() && measured.loading }}>{sizeText()}</dd>
              </Show>
              <Show when={alone()}>
                <Show when={when(found.created)}>
                  <dt>Created</dt>
                  <dd>{when(found.created)}</dd>
                </Show>
                <Show when={when(found.modified)}>
                  <dt>Modified</dt>
                  <dd>{when(found.modified)}</dd>
                </Show>
                <Show when={!found.isRoot && when(found.accessed)}>
                  <dt>Opened</dt>
                  <dd>{when(found.accessed)}</dd>
                </Show>
              </Show>
              <Show when={!found.isRoot}>
                <dt>In use by</dt>
                <dd>{usersText()}</dd>
              </Show>
              <Show when={isFile()}>
                <dt>Opens with</dt>
                <dd class="properties-place">
                  <span>{found.defaultApp ?? "No app yet"}</span>
                  <button class="details-button" onClick={() => close(() => props.onPickApp(paths()))}>
                    Change
                  </button>
                </dd>
              </Show>
            </dl>

            <Show when={!found.isRoot}>
              <div class="properties-switches">
                <Show when={found.files > 0}>
                  <Switch
                    label="Read-only"
                    note={found.readOnly === "some" ? "Some of the files are" : found.folders > 0 ? "For the files, not what is in the folders" : undefined}
                    checked={found.readOnly === "all"}
                    onChange={() => change("readOnly", found.readOnly)}
                  />
                </Show>
                <Switch
                  label="Hidden"
                  note={found.hidden === "some" ? "Some of them are" : found.folders > 0 ? "Not what is inside" : undefined}
                  checked={found.hidden === "all"}
                  onChange={() => change("hidden", found.hidden)}
                />
              </div>
            </Show>

            <Show when={selection && tags().length > 0}>
              <div class="properties-tags" role="group" aria-label="Tags">
                <For each={tags()}>
                  {(tag) => (
                    <button class="properties-tag" aria-pressed={common().includes(tag.id)} onClick={() => toggleTag(tag.id)}>
                      <span class="tag-dot" style={{ background: tagColor(tag.color) }} />
                      {tag.name}
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <Show when={isFile() || (more()?.length ?? 0) > 0}>
              <details class="properties-more" onToggle={(event) => setMoreOpen(event.currentTarget.open)}>
                <summary>More details</summary>
                <dl class="details-facts">
                  <For each={more() ?? []}>
                    {([group, label, value], at) => (
                      <>
                        <Show when={group !== more()![at() - 1]?.[0]}>
                          <dt class="details-group">{group}</dt>
                        </Show>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </>
                    )}
                  </For>
                  <Show when={isFile() && moreOpen()}>
                    <Checksum wait={found.onlineOnly} compute={(algorithm) => pathChecksum(first(), algorithm)} />
                  </Show>
                </dl>
              </details>
            </Show>
            <Show when={failure()}>
              <p class="properties-failure" role="alert">
                {failure()}
              </p>
            </Show>
          </div>
        )}
      </Show>

      <div class="confirm-buttons properties-buttons">
        <button class="properties-link" onClick={() => close(props.onWindows)}>
          Windows Properties
        </button>
        <span class="properties-said" role="status">
          {copied()}
        </span>
        <button class="job-choice" disabled={!facts()} onClick={copyDetails}>
          Copy details
        </button>
        <button ref={done} class="job-choice" onClick={() => close()}>
          Done
        </button>
      </div>
    </dialog>
  );
}
