import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import {
  appsForPaths,
  browseApp,
  chooseAppFor,
  fetchPictureFile,
  openPathsWith,
  openPathsWithExe,
  type App,
} from "../../api";
import { saved } from "../filelist/prefs";
import { openSheet } from "../../ui/sheet";
import { draw } from "../preview/QuickPreview";
import { counted, matching, nameOf } from "./parts";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "./dialogs.css";

const ICON_EDGE = 32;
const ICON_APP = "";

const extensionOf = (path: string) => nameOf(path).split(".").pop()?.toLowerCase() ?? "";
const lastKey = (path: string) => `app-last-${extensionOf(path)}`;

function AppIcon(props: { icon: string | null }) {
  const [picture] = createResource(
    () => props.icon,
    (file) => fetchPictureFile(file, ICON_EDGE * Math.ceil(devicePixelRatio)).catch(() => null),
  );
  return (
    <Show when={picture()} keyed fallback={<span class="app-icon app-glyph">{ICON_APP}</span>}>
      {(thumb) => <canvas ref={(canvas) => draw(canvas, thumb)} class="app-icon" />}
    </Show>
  );
}

/**
 * Perli's own "Open with": every app that can open the files, the ones Windows suggests first,
 * found by typing. An app no list has is browsed for or pasted. Making one the default goes to
 * Windows, which lets nothing else set it.
 */
export function AppPicker(props: { paths: string[]; onClose: () => void }) {
  const [apps] = createResource(() => appsForPaths(props.paths));
  const [query, setQuery] = createSignal("");
  const [at, setAt] = createSignal(0);
  const [exe, setExe] = createSignal("");
  const [failure, setFailure] = createSignal<string>();
  let dialog!: HTMLDialogElement;
  let search!: HTMLInputElement;
  let list!: HTMLDivElement;
  let close!: ReturnType<typeof openSheet>;

  const last = saved(lastKey(props.paths[0]));
  /** The app used last for this type leads, then what Windows suggests, then the rest. */
  const shown = createMemo(() => {
    const rank = (app: App) => (app.id === last ? 0 : app.recommended ? 1 : 2);
    const found = matching(apps() ?? [], query());
    return found.map((app) => ({ app, rank: rank(app) })).sort((a, b) => a.rank - b.rank);
  });
  const GROUPS = ["Used last", "Suggested", "More apps"];

  function run(opening: Promise<void>, used?: string) {
    opening
      .then(() => {
        if (used) localStorage.setItem(`perli-${lastKey(props.paths[0])}`, JSON.stringify(used));
        close();
      })
      .catch((reason) => setFailure(String(reason)));
  }

  const open = (app: App) => run(openPathsWith(props.paths, app.id), app.id);
  const openExe = () => exe().trim() && run(openPathsWithExe(props.paths, exe().trim().replace(/^"|"$/g, "")));

  async function browse() {
    try {
      const picked = await browseApp();
      if (!picked) return;
      setExe(picked);
      run(openPathsWithExe(props.paths, picked));
    } catch (reason) {
      setFailure(String(reason));
    }
  }

  function move(by: number) {
    const next = Math.max(0, Math.min(shown().length - 1, at() + by));
    setAt(next);
    list.querySelectorAll(".app-row")[next]?.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.target !== search) return;
    if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (event.key === "Enter" && shown()[at()]) open(shown()[at()].app);
    else return;
    event.preventDefault();
  }

  onMount(() => {
    close = openSheet(dialog);
    search.focus();
  });

  return (
    <dialog ref={dialog} class="settings confirm app-picker" aria-label="Open with" onClose={props.onClose} onKeyDown={onKeyDown}>
      <h2>Open with</h2>
      <p class="app-what">
        {props.paths.length === 1 ? nameOf(props.paths[0]) : counted(props.paths.length, "file", "files")}
      </p>
      <input
        ref={search}
        class="app-search"
        placeholder="Find an app"
        aria-label="Find an app"
        spellcheck={false}
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setAt(0);
        }}
      />
      <div ref={list} class="app-list" role="listbox" aria-label="Apps">
        <For
          each={shown()}
          fallback={
            <p class="app-none">
              {apps.loading ? "Looking for apps…" : query() ? "No app has that name." : "Windows lists no app for this. Browse for one below."}
            </p>
          }
        >
          {({ app, rank }, index) => (
            <>
              <Show when={rank !== shown()[index() - 1]?.rank}>
                <p class="app-group">{GROUPS[rank]}</p>
              </Show>
              <button
                class="app-row"
                role="option"
                aria-selected={at() === index()}
                style={{ "--at": Math.min(index(), 12) }}
                onPointerMove={() => setAt(index())}
                onClick={() => open(app)}
              >
                <AppIcon icon={app.icon} />
                <span class="app-name">{app.name}</span>
              </button>
            </>
          )}
        </For>
      </div>
      <div class="app-other">
        <input
          class="app-search"
          placeholder="Or paste the path of an app"
          aria-label="Path of an app"
          spellcheck={false}
          value={exe()}
          onInput={(event) => setExe(event.currentTarget.value)}
          onKeyDown={(event) => event.key === "Enter" && openExe()}
        />
        <button class="job-choice" onClick={browse}>
          Browse…
        </button>
        <button class="job-choice" disabled={!exe().trim()} onClick={openExe}>
          Open
        </button>
      </div>
      <Show when={failure()}>
        <p class="properties-failure" role="alert">
          {failure()}
        </p>
      </Show>
      <div class="confirm-buttons properties-buttons">
        <Show when={props.paths.length === 1}>
          <button class="properties-link" onClick={() => close(() => chooseAppFor(props.paths[0]).catch(console.error))}>
            Always use an app…
          </button>
        </Show>
        <span class="properties-said" />
        <button class="job-choice" onClick={() => close()}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
