import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Effect, getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createTag, exportSettings, importSettings, isDefaultApp, listTags, setDefaultApp } from "../../api";
import type { Tag } from "../../api";
import { ColorField, Switch } from "../../ui/Controls";
import { morph } from "../../ui/morph";
import {
  dateForm,
  folderSizes,
  hoverCards,
  onePerDrive,
  setOnePerDrive,
  setVerifyCopies,
  verifyCopies,
  inlineFolders,
  setInlineFolders,
  openInWindow,
  ROW_HEIGHTS,
  rowDensity,
  selectionBar,
  setDateForm,
  setHoverCards,
  setOpenInWindow,
  setRowDensity,
  setSelectionBar,
  setStatusBar,
  setWindowsIcons,
  statusBar,
  windowsIcons,
  type DateForm,
  type Density,
} from "../filelist/prefs";
import { keyText } from "../keys/keybinds";
import { VIEWER_SETTINGS } from "../preview/viewerPrefs";
import { setSidebarOpen, sidebarOpen } from "../sidebar/saved";
import { TagSettings } from "../tags/TagSettings";
import {
  accent,
  accentColors,
  ACCENTS,
  addPalette,
  backdrop,
  BACKDROPS,
  changePalette,
  deletePalette,
  ownPalette,
  palettes,
  readWindowsColor,
  SCALES,
  setAccent,
  setBackdrop,
  setTheme,
  setUiScale,
  theme,
  THEMES,
  uiScale,
  WINDOWS_ACCENT,
  type Accent,
  type Backdrop,
  type Theme,
} from "./appearance";
import { missingTags, packed, remapTags, settingsOf, staleSettings, storageKey, unpacked } from "./backup";
import { type Palette } from "./palettes";
import { fitsSearch } from "./search";
import {
  checkOnStart,
  currentVersion,
  installNow,
  lookForUpdate,
  setCheckOnStart,
  updateFailure,
  updateOffer,
  updateState,
} from "./updates";
import "./settings.css";

const DENSITIES: { id: Density; label: string }[] = [
  { id: "compact", label: "Compact" },
  { id: "cozy", label: "Cozy" },
  { id: "roomy", label: "Roomy" },
];
const DATE_FORMS: { id: DateForm; label: string }[] = [
  { id: "short", label: "Short" },
  { id: "ago", label: "How long ago" },
  { id: "iso", label: "ISO" },
];
const COLOR_NAMES = ["First color", "Middle color", "Last color"];
const ACCENT_VARS = ["--accent-start", "--accent", "--accent-end"];
const EFFECTS: Record<Exclude<Backdrop, "solid">, Effect> = {
  mica: Effect.Mica,
  tabbed: Effect.Tabbed,
  acrylic: Effect.Acrylic,
};

/** The page's parts, in the order the side list and the page both show them. */
const SECTIONS = [
  { id: "look", label: "Look", icon: "" },
  { id: "files", label: "Files", icon: "" },
  { id: "sidebar", label: "Sidebar", icon: "" },
  { id: "tags", label: "Tags", icon: "" },
  { id: "viewers", label: "Viewers", icon: "" },
  { id: "default", label: "Default file manager", icon: "" },
  { id: "backup", label: "Backup", icon: "" },
  { id: "updates", label: "Updates", icon: "" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const ICON_CLOSE = "";

/** Changes one color, and keeps the other two. */
function withColor(palette: Palette, at: number, color: string): Palette {
  const colors = [...palette.colors] as Palette["colors"];
  colors[at] = color;
  return { ...palette, colors };
}

/** The style that paints an element in an accent: its three colors, when no style rule has them. */
const accentStyle = (id: Accent) =>
  Object.fromEntries((accentColors(id) ?? []).map((color, at) => [ACCENT_VARS[at], color]));

/**
 * The settings, as a page with its own tab. Each change shows at once, and the small window at
 * the top tries a theme or an accent on while the pointer is over it. Every setting here is also
 * where it is used: in the View menu, the command palette or a viewer's cog.
 */
export function Settings(props: {
  /** The settings tab exists. */
  open: boolean;
  /** The settings tab is the one in front. */
  shown: boolean;
  onClose: () => void;
  onToggleSizes: () => void;
  onTagsChanged: () => void;
  onDeleteTag: (tag: Tag) => void;
  /** Saves what must survive Perli ending for an update. */
  onBeforeUpdate: () => Promise<unknown>;
  /** Opens the sheet of keyboard shortcuts. */
  onKeys: () => void;
}) {
  const [isDefault, setIsDefault] = createSignal(false);
  const [defaultFailure, setDefaultFailure] = createSignal<string>();
  const [backupNote, setBackupNote] = createSignal<string>();
  const [hidden, setHidden] = createSignal<SectionId[]>([]);
  const [current, setCurrent] = createSignal<SectionId>("look");
  // Closing drops the page and its empty search box, so a search's hidden parts go with it.
  createEffect(on(() => props.open, (open) => open || setHidden([])));
  /** What the pointer is over, which the small window tries on. */
  const [tryTheme, setTryTheme] = createSignal<Theme>();
  const [tryAccent, setTryAccent] = createSignal<Accent>();
  let searchInput: HTMLInputElement | undefined;
  let body: HTMLDivElement | undefined;

  createEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme();
    root.dataset.accent = accent();
    // These accents have no rule in the style sheet, so their colors go on the page itself.
    const colors = accentColors(accent());
    ACCENT_VARS.forEach((name, at) =>
      colors ? root.style.setProperty(name, colors[at]) : root.style.removeProperty(name),
    );
  });

  // The window frame and Mica follow Windows unless told otherwise.
  createEffect(
    on(theme, (value, previous) => {
      if (previous === undefined && value === "system") return;
      getCurrentWindow()
        .setTheme(value === "system" ? null : value)
        .catch(console.error);
    }),
  );

  // The window starts as Mica, so only another choice needs a word with Windows.
  createEffect(
    on(backdrop, (value, previous) => {
      document.documentElement.dataset.backdrop = value;
      if (previous === undefined && value === "mica") return;
      const appWindow = getCurrentWindow();
      (value === "solid" ? appWindow.clearEffects() : appWindow.setEffects({ effects: [EFFECTS[value]] })).catch(
        console.error,
      );
    }),
  );

  createEffect(
    on(uiScale, (value, previous) => {
      if (previous === undefined && value === 1) return;
      getCurrentWebview().setZoom(value).catch(console.error);
    }),
  );

  // The accent of Windows can change while Perli is in the background.
  const followWindows = () => accent() === WINDOWS_ACCENT && readWindowsColor();
  createEffect(followWindows);
  onMount(() => window.addEventListener("focus", followWindows));
  onCleanup(() => window.removeEventListener("focus", followWindows));

  createEffect(() => {
    if (props.open) isDefaultApp().then(setIsDefault).catch(console.error);
  });

  createEffect(() => {
    if (props.shown) queueMicrotask(() => searchInput?.focus({ preventScroll: true }));
  });

  function chooseTheme(next: Theme, from: HTMLElement) {
    if (next === theme()) return;
    const { left, top, width, height } = from.getBoundingClientRect();
    const root = document.documentElement;
    root.style.setProperty("--reveal-x", `${left + width / 2}px`);
    root.style.setProperty("--reveal-y", `${top + height / 2}px`);
    morph(() => setTheme(next), "theme");
  }

  /** Hides the parts that don't have every word typed, in their text or their extra words. */
  function search(query: string) {
    if (!body) return;
    const gone: SectionId[] = [];
    for (const section of body.querySelectorAll<HTMLElement>(".settings-section")) {
      section.hidden = !fitsSearch(`${section.textContent} ${section.dataset.words ?? ""}`, query);
      if (section.hidden) gone.push(section.dataset.section as SectionId);
    }
    setHidden(gone);
  }

  const sectionOf = (id: SectionId) => body?.querySelector<HTMLElement>(`[data-section="${id}"]`);

  function go(id: SectionId) {
    sectionOf(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setCurrent(id);
  }

  /** The part the eye is on: the last one whose heading has reached the top. */
  function spy() {
    if (!body) return;
    const line = body.scrollTop + body.clientHeight / 4;
    const reached = SECTIONS.filter(({ id }) => !hidden().includes(id) && (sectionOf(id)?.offsetTop ?? Infinity) <= line);
    if (reached.length > 0) setCurrent(reached.at(-1)!.id);
  }

  async function saveBackup() {
    try {
      const prefs = settingsOf(Object.entries(localStorage));
      const tags = (await listTags()).map(({ name, color, id }) => ({ name, color, id }));
      if (await exportSettings(packed({ prefs, tags }))) setBackupNote("Settings saved.");
    } catch (failure) {
      setBackupNote(String(failure));
    }
  }

  /** The window starts over, because every part of Perli read its settings when it began. */
  async function loadBackup() {
    try {
      const text = await importSettings();
      if (text === null) return;
      const { prefs: saved, tags } = unpacked(text);
      for (const tag of missingTags(tags, await listTags())) await createTag(tag.name, tag.color);
      const prefs = remapTags(saved, tags, await listTags());
      // A setting the file lacks was at its start value when saved, so it goes back to that.
      const current = settingsOf(Object.entries(localStorage));
      for (const name of staleSettings(current, prefs)) localStorage.removeItem(storageKey(name));
      for (const [name, value] of Object.entries(prefs)) localStorage.setItem(storageKey(name), value);
      await props.onBeforeUpdate();
      location.reload();
    } catch (failure) {
      setBackupNote(failure instanceof Error ? failure.message : String(failure));
    }
  }

  async function toggleDefault() {
    const on = !isDefault();
    try {
      await setDefaultApp(on);
      setIsDefault(on);
      setDefaultFailure(undefined);
    } catch (failure) {
      setDefaultFailure(String(failure));
    }
  }

  const shownTheme = () => tryTheme() ?? theme();
  const shownAccent = () => tryAccent() ?? accent();

  const AccentChoice = (choice: { id: Accent; label: string }) => (
    <button
      class="settings-chip settings-accent"
      role="radio"
      aria-checked={accent() === choice.id}
      onClick={() => setAccent(choice.id)}
      onPointerEnter={() => setTryAccent(choice.id)}
      onPointerLeave={() => setTryAccent(undefined)}
    >
      <span class="settings-swatch" data-accent={choice.id} style={accentStyle(choice.id)} />
      {choice.label}
    </button>
  );

  return (
    <Show when={props.open}>
      <section class="settings-page" hidden={!props.shown} aria-label="Settings">
        <nav class="settings-nav" aria-label="Parts of the settings">
          <h2>Settings</h2>
          <input
            ref={searchInput}
            class="settings-search"
            type="search"
            aria-label="Search settings"
            placeholder="Search settings"
            spellcheck={false}
            onInput={(event) => search(event.currentTarget.value)}
          />
          <For each={SECTIONS}>
            {(section) => (
              <button
                class="settings-link"
                aria-current={current() === section.id ? "true" : undefined}
                hidden={hidden().includes(section.id)}
                onClick={() => go(section.id)}
              >
                <span class="settings-link-icon" aria-hidden="true">
                  {section.icon}
                </span>
                {section.label}
              </button>
            )}
          </For>
          <Show when={hidden().length === SECTIONS.length}>
            <p class="settings-note">No setting has those words.</p>
          </Show>
          <button class="settings-link settings-done" aria-keyshortcuts="Escape" onClick={props.onClose}>
            <span class="settings-link-icon" aria-hidden="true">
              {ICON_CLOSE}
            </span>
            Close settings
          </button>
        </nav>

        <div ref={body} class="settings-body" onScroll={spy}>
          <section
            class="settings-section"
            data-section="look"
            data-words="appearance dark light mode system theme color colour palette accent windows backdrop mica acrylic solid transparent glass size zoom scale text font bigger smaller"
          >
            <h3>Look</h3>
            <div
              class="look-preview"
              aria-hidden="true"
              data-accent={shownAccent()}
              style={{
                "color-scheme": shownTheme() === "system" ? undefined : shownTheme(),
                "--look-row": `${ROW_HEIGHTS[rowDensity()]}px`,
                ...accentStyle(shownAccent()),
              }}
            >
              <div class="look-tabs">
                <span class="look-tab look-tab-on">Photos</span>
                <span class="look-tab">Work</span>
              </div>
              <div class="look-rows">
                <span class="look-row">
                  <i class="look-tile" />
                  Holiday
                  <span class="look-date look-date-fresh">Today</span>
                </span>
                <span class="look-row look-row-on">
                  <i class="look-tile" />
                  Notes.txt
                  <span class="look-date">Last week</span>
                </span>
                <span class="look-row">
                  <i class="look-tile" />
                  Budget.xlsx
                  <span class="look-date">March</span>
                </span>
              </div>
            </div>

            <h4 id="settings-theme">Theme</h4>
            <div class="settings-chips" role="radiogroup" aria-labelledby="settings-theme">
              <For each={THEMES}>
                {(choice) => (
                  <button
                    class="settings-chip"
                    role="radio"
                    aria-checked={theme() === choice.id}
                    onClick={(event) => chooseTheme(choice.id, event.currentTarget)}
                    onPointerEnter={() => setTryTheme(choice.id)}
                    onPointerLeave={() => setTryTheme(undefined)}
                  >
                    {choice.label}
                  </button>
                )}
              </For>
            </div>

            <h4 id="settings-accent">Accent</h4>
            <div class="settings-chips" role="radiogroup" aria-labelledby="settings-accent">
              <For each={ACCENTS}>{(choice) => <AccentChoice id={choice.id} label={choice.label} />}</For>
              <AccentChoice id={WINDOWS_ACCENT} label="Windows" />
              <For each={palettes()}>{(palette) => <AccentChoice id={palette.id} label={palette.name} />}</For>
              <button class="settings-chip" onClick={addPalette}>
                New palette
              </button>
            </div>
            <Show when={accent() === WINDOWS_ACCENT}>
              <p class="settings-note">Follows the accent color picked in Windows, and changes when it does.</p>
            </Show>
            {/* Kept by the palette's id, so a color changing under the open picker doesn't close it. */}
            <Show when={ownPalette()?.id} keyed>
              {(_id) => {
                let kept = ownPalette()!;
                const palette = () => (kept = ownPalette() ?? kept);
                return (
                  <div class="settings-palette">
                    <input
                      class="settings-palette-name"
                      aria-label="Palette name"
                      spellcheck={false}
                      value={palette().name}
                      onChange={(event) =>
                        changePalette({ ...palette(), name: event.currentTarget.value.trim() || palette().name })
                      }
                    />
                    <For each={COLOR_NAMES}>
                      {(name, at) => (
                        <ColorField
                          label={name}
                          value={palette().colors[at()]}
                          onChange={(color) => changePalette(withColor(palette(), at(), color))}
                        />
                      )}
                    </For>
                    <button class="settings-chip" onClick={() => deletePalette(palette().id)}>
                      Delete palette
                    </button>
                  </div>
                );
              }}
            </Show>

            <h4 id="settings-backdrop">Window backdrop</h4>
            <div class="settings-chips" role="radiogroup" aria-labelledby="settings-backdrop">
              <For each={BACKDROPS}>
                {(choice) => (
                  <button
                    class="settings-chip"
                    role="radio"
                    aria-checked={backdrop() === choice.id}
                    onClick={() => setBackdrop(choice.id)}
                  >
                    {choice.label}
                  </button>
                )}
              </For>
            </div>
            <p class="settings-note">
              What shows behind the sidebar and the tabs. Mica takes its tint from the desktop picture, Acrylic shows
              the windows behind Perli, blurred, and Solid shows nothing through.
            </p>

            <h4 id="settings-scale">Text and interface size</h4>
            <div class="settings-chips" role="radiogroup" aria-labelledby="settings-scale">
              <For each={SCALES}>
                {(scale) => (
                  <button
                    class="settings-chip"
                    role="radio"
                    aria-checked={uiScale() === scale}
                    onClick={() => setUiScale(scale)}
                  >
                    {Math.round(scale * 100)}%
                  </button>
                )}
              </For>
            </div>
          </section>

          <section
            class="settings-section"
            data-section="files"
            data-words="rows density compact cozy roomy height icons windows list status bar count selected items hover cards preview tooltip picture folder sizes space disk dates ago iso modified selection actions keyboard shortcuts keys copy copying verify check queue drive turn"
          >
            <h3>Files</h3>
            <h4 id="settings-rows">Row height</h4>
            <div class="settings-chips" role="radiogroup" aria-labelledby="settings-rows">
              <For each={DENSITIES}>
                {(choice) => (
                  <button
                    class="settings-chip"
                    role="radio"
                    aria-checked={rowDensity() === choice.id}
                    onClick={() => setRowDensity(choice.id)}
                  >
                    {choice.label}
                  </button>
                )}
              </For>
            </div>
            <p class="settings-note">Roomy rows show each file's kind and size under its name.</p>
            <h4 id="settings-dates">Dates</h4>
            <div class="settings-chips" role="radiogroup" aria-labelledby="settings-dates">
              <For each={DATE_FORMS}>
                {(choice) => (
                  <button
                    class="settings-chip"
                    role="radio"
                    aria-checked={dateForm() === choice.id}
                    onClick={() => setDateForm(choice.id)}
                  >
                    {choice.label}
                  </button>
                )}
              </For>
            </div>
            <p class="settings-note">The full date and time show when the pointer rests on a date.</p>
            <Switch
              label="Use Windows icons"
              note="Off, files wear Perli's own icons. Pictures and videos still show themselves, and a folder Windows gave its own icon keeps it."
              checked={windowsIcons()}
              onChange={setWindowsIcons}
            />
            <Switch
              label="Always show the status bar"
              note="Off, a quiet line shows the count and the selection only when they change."
              checked={statusBar()}
              onChange={setStatusBar}
            />
            <Switch
              label="Show a bar of actions over the selection"
              note="Off, the same actions stay in the menu of a row and on their keys."
              checked={selectionBar()}
              onChange={setSelectionBar}
            />
            <Switch
              label="Open folders in place with an arrow"
              note="In the list, a folder's arrow shows what is in it under its row. Right and Left do the same."
              checked={inlineFolders()}
              onChange={setInlineFolders}
            />
            <Switch
              label="Show details when the pointer rests on a file"
              note="Text files show their first lines, and other files their picture."
              checked={hoverCards()}
              onChange={setHoverCards}
            />
            <Switch
              label="Add up folders in the background"
              note="The Size column fills in as Perli walks each folder you open. Links are not followed, and cloud files stay in the cloud."
              checked={folderSizes()}
              onChange={props.onToggleSizes}
            />
            <h4>Copying</h4>
            <Switch
              label="Check each copy against its original"
              note="Every copied file is read back and compared. A copy that doesn't match is reported, to try again. It takes about twice as long."
              checked={verifyCopies()}
              onChange={setVerifyCopies}
            />
            <Switch
              label="One copy at a time per drive"
              note="A copy to or from a drive that is busy waits its turn. Its card says what it waits for, and Start now runs it anyway."
              checked={onePerDrive()}
              onChange={setOnePerDrive}
            />
            <h4>Keyboard</h4>
            <div class="settings-chips">
              <button class="settings-chip" aria-keyshortcuts={keyText("keys").replace("Ctrl", "Control") || undefined} onClick={props.onKeys}>
                Keyboard shortcuts…
              </button>
            </div>
            <p class="settings-note">Every key Perli answers to, and where each one is changed.</p>
          </section>

          <section class="settings-section" data-section="sidebar" data-words="rail places panel narrow wide">
            <h3>Sidebar</h3>
            <Switch
              label="Keep the sidebar open"
              note={`Off, the sidebar is a slim rail of icons. It slides out when the pointer reaches it${keyText("sidebar") ? `, and ${keyText("sidebar")} keeps it open` : ""}.`}
              checked={sidebarOpen()}
              onChange={setSidebarOpen}
            />
          </section>

          <section class="settings-section" data-section="tags" data-words="label color">
            <h3>Tags</h3>
            <TagSettings onChanged={props.onTagsChanged} onDelete={props.onDeleteTag} />
          </section>

          <section
            class="settings-section"
            data-section="viewers"
            data-words="preview picture text book comic manga model 3d music song player quick"
          >
            <h3>Viewers</h3>
            <p class="settings-note">The same switches are behind the cog of each viewer, where they are used.</p>
            <For each={Object.entries(VIEWER_SETTINGS)}>
              {([viewer, items]) => (
                <>
                  <h4>{viewer}</h4>
                  <For each={items}>
                    {(item) => <Switch label={item.label} checked={item.checked()} onChange={item.toggle} />}
                  </For>
                </>
              )}
            </For>
          </section>

          <section
            class="settings-section"
            data-section="default"
            data-words="explorer default app windows tab window show in folder"
          >
            <h3>Default file manager</h3>
            <Switch
              label="Open folders in Perli"
              note="This PC, Control Panel and other places without a path still open in File Explorer, and so do the taskbar, Start and the Open dialogs of other apps."
              checked={isDefault()}
              onChange={toggleDefault}
            />
            <Switch
              label="Give each folder opened from outside a window of its own"
              note="Off, a folder opened from the desktop or another app becomes a tab in the Perli that is running."
              checked={openInWindow()}
              onChange={setOpenInWindow}
            />
            <Show when={defaultFailure()}>
              <p class="settings-note" role="alert">
                {defaultFailure()}
              </p>
            </Show>
          </section>

          <section
            class="settings-section"
            data-section="backup"
            data-words="export import save restore file move computer settings json"
          >
            <h3>Backup</h3>
            <p class="settings-note">
              Every setting, your keys, bookmarks, pinned places and folder looks, and the names and colors of your tags,
              as one file. Which files wear each tag stays on this computer.
            </p>
            <div class="settings-chips">
              <button class="settings-chip" onClick={saveBackup}>
                Export settings…
              </button>
              <button class="settings-chip" onClick={loadBackup}>
                Import settings…
              </button>
            </div>
            <Show when={backupNote()}>
              <p class="settings-note" role="status">
                {backupNote()}
              </p>
            </Show>
          </section>

          <section class="settings-section" data-section="updates" data-words="version upgrade new release">
            <h3>Updates</h3>
            <p class="settings-note settings-update" role="status">
              {
                {
                  idle: `Perli ${currentVersion()}`,
                  checking: "Checking for updates…",
                  current: `Perli ${currentVersion()} is up to date.`,
                  ready: `Perli ${updateOffer()?.version} is ready to install.`,
                  installing: "Downloading the update. Perli restarts when it is done.",
                  failed: "Perli could not check for updates.",
                }[updateState()]
              }
            </p>
            <Show when={updateState() === "ready" && updateOffer()?.notes}>
              <p class="settings-note">{updateOffer()?.notes}</p>
            </Show>
            <div class="settings-chips">
              <Show
                when={updateState() === "ready" || updateState() === "installing"}
                fallback={
                  <button class="settings-chip" disabled={updateState() === "checking"} onClick={() => lookForUpdate()}>
                    Check for updates
                  </button>
                }
              >
                <button
                  class="settings-chip"
                  disabled={updateState() === "installing"}
                  onClick={() => installNow(props.onBeforeUpdate)}
                >
                  Install and restart
                </button>
              </Show>
            </div>
            <Switch label="Check when Perli starts" checked={checkOnStart()} onChange={setCheckOnStart} />
            <Show when={updateFailure()}>
              <p class="settings-note" role="alert">
                {updateFailure()}
              </p>
            </Show>
          </section>
        </div>
      </section>
    </Show>
  );
}
