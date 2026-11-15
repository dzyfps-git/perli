import { createSignal, For, Show } from "solid-js";
import { exportSettings, fetchPictureFile, importSettings, wallpaperNow } from "../../api";
import { cssHex } from "../../ui/color";
import { ColorField, Switch } from "../../ui/Controls";
import { hueOf, type Kind } from "../filelist/fileKinds";
import { extensionKey, KIND_LABELS, PLAIN_THEME, themeFromText, themeText, type IconStyle, type IconTheme } from "../filelist/iconTheme";
import { iconTheme, setIconTheme } from "../filelist/prefs";
import { paletteFromPixels } from "./palettes";

const ICON_CLOSE = "";
const ICON_RESET = "";
const STYLES: { id: IconStyle; label: string }[] = [
  { id: "tile", label: "Soft tile" },
  { id: "line", label: "Drawing only" },
  { id: "solid", label: "Full tile" },
];
const KINDS = Object.keys(KIND_LABELS) as Kind[];
/** The kinds ready-made colors change. Folders keep the accent, and the gray kinds their gray. */
const HUED = KINDS.filter((kind) => kind !== "folder" && hueOf(kind) !== undefined);
/** Ready-made colors: a CSS color for each hue, which the page turns into hex. */
const PRESETS: { label: string; color: (hue: number) => string }[] = [
  { label: "Vivid", color: (hue) => `oklch(0.66 0.19 ${hue})` },
  { label: "Pastel", color: (hue) => `oklch(0.86 0.07 ${hue})` },
  { label: "Mono", color: () => "oklch(0.64 0.01 270)" },
];
/** How far apart, in degrees, kinds sharing one color of the desktop picture are turned. */
const WALLPAPER_SPREAD = 14;

/** Settings for file icons: a style, a color per kind, ready-made colors, and extensions shown
 *  as another kind. */
export function IconSettings() {
  const [note, setNote] = createSignal("");
  const [before, setBefore] = createSignal<IconTheme>();

  const change = (part: Partial<IconTheme>) => {
    setBefore(undefined);
    setIconTheme({ ...iconTheme(), ...part });
  };
  /** A change of many things at once, which Undo takes back. */
  function replace(theme: IconTheme, said: string) {
    setBefore(iconTheme());
    setIconTheme(theme);
    setNote(said);
  }
  const withColors = (color: (kind: Kind, at: number) => string): IconTheme => ({
    ...iconTheme(),
    colors: { ...iconTheme().colors, ...Object.fromEntries(HUED.map((kind, at) => [kind, cssHex(color(kind, at))])) },
  });

  async function fromWallpaper() {
    try {
      const path = await wallpaperNow();
      const picture = path && (await fetchPictureFile(path, 96));
      if (!picture) return setNote("The desktop picture couldn't be read.");
      const picked = paletteFromPixels(picture.pixels);
      const turn = (at: number) => ((Math.floor(at / picked.length) % 5) - 2) * WALLPAPER_SPREAD;
      replace(
        withColors((_kind, at) => `oklch(from ${picked[at % picked.length]} 0.74 max(c, 0.09) calc(h + ${turn(at)}))`),
        "Colors taken from the desktop picture.",
      );
    } catch (failure) {
      setNote(String(failure));
    }
  }

  function addExtension(form: HTMLFormElement) {
    const typed = form.elements.namedItem("extension") as HTMLInputElement;
    const kind = (form.elements.namedItem("kind") as HTMLSelectElement).value as Kind;
    const extension = extensionKey(typed.value);
    if (!extension) return setNote("Type an extension, such as .nfo.");
    change({ extensions: { ...iconTheme().extensions, [extension]: kind } });
    setNote(`.${extension} files now show as ${KIND_LABELS[kind].toLowerCase()}.`);
    typed.value = "";
  }

  function dropExtension(extension: string) {
    const { [extension]: _gone, ...rest } = iconTheme().extensions;
    change({ extensions: rest });
  }

  async function exportTheme() {
    try {
      if (await exportSettings(themeText(iconTheme()), "Perli icons.json")) setNote("Icon theme saved.");
    } catch (failure) {
      setNote(String(failure));
    }
  }

  async function importTheme() {
    try {
      const text = await importSettings();
      if (text === null) return;
      const theme = themeFromText(text);
      if (!theme) return setNote("That file holds no icon theme.");
      replace(theme, "Icon theme loaded.");
    } catch (failure) {
      setNote(String(failure));
    }
  }

  return (
    <>
      <h4 id="settings-icon-style">Style</h4>
      <div class="settings-chips" role="radiogroup" aria-labelledby="settings-icon-style">
        <For each={STYLES}>
          {(choice) => (
            <button class="settings-chip" role="radio" aria-checked={iconTheme().style === choice.id} onClick={() => change({ style: choice.id })}>
              {choice.label}
            </button>
          )}
        </For>
      </div>
      <Switch
        label="Follow the accent color"
        note="Each kind takes a hue near the accent and changes when it does. Colors you set below still win."
        checked={iconTheme().accent}
        onChange={(accent) => change({ accent })}
      />

      <h4 id="settings-icon-colors">Colors</h4>
      <div class="settings-chips" role="group" aria-labelledby="settings-icon-colors">
        <For each={PRESETS}>
          {(preset) => (
            <button class="settings-chip" onClick={() => replace(withColors((kind) => preset.color(hueOf(kind)!)), `${preset.label} colors.`)}>
              {preset.label}
            </button>
          )}
        </For>
        <button class="settings-chip" onClick={() => void fromWallpaper()}>
          From the desktop picture
        </button>
      </div>
      <div class="icon-kinds">
        <For each={KINDS}>
          {(kind) => (
            <div class="icon-kind" data-kind={kind}>
              <span class="file-icon" data-kind={kind} />
              <span class="icon-kind-name">{KIND_LABELS[kind]}</span>
              <ColorField
                label={`Color of ${KIND_LABELS[kind].toLowerCase()}`}
                value={iconTheme().colors[kind] ?? "var(--kind-color)"}
                onChange={(color) => change({ colors: { ...iconTheme().colors, [kind]: color } })}
              />
              <button
                class="tag-delete"
                aria-label={`Perli's color for ${KIND_LABELS[kind].toLowerCase()}`}
                disabled={!iconTheme().colors[kind]}
                onClick={() => {
                  const { [kind]: _gone, ...rest } = iconTheme().colors;
                  change({ colors: rest });
                }}
              >
                {ICON_RESET}
              </button>
            </div>
          )}
        </For>
      </div>

      <h4>Shown as another kind</h4>
      <For
        each={Object.entries(iconTheme().extensions)}
        fallback={<p class="settings-note">Give an extension Perli doesn't know, or knows differently, the icon of a kind.</p>}
      >
        {([extension, kind]) => (
          <div class="icon-kind">
            <span class="file-icon" data-kind={kind} />
            <span class="icon-kind-name">.{extension}</span>
            <span class="settings-note">{KIND_LABELS[kind]}</span>
            <button class="tag-delete" aria-label={`Stop showing .${extension} files as ${KIND_LABELS[kind].toLowerCase()}`} onClick={() => dropExtension(extension)}>
              {ICON_CLOSE}
            </button>
          </div>
        )}
      </For>
      <form
        class="icon-extension-add"
        onSubmit={(event) => {
          event.preventDefault();
          addExtension(event.currentTarget);
        }}
      >
        <label class="rename-field">
          <input name="extension" aria-label="Extension" placeholder=".nfo" spellcheck={false} />
        </label>
        <select name="kind" aria-label="Show as">
          <For each={KINDS}>{(kind) => <option value={kind}>{KIND_LABELS[kind]}</option>}</For>
        </select>
        <button class="settings-chip" type="submit">
          Add
        </button>
      </form>

      <div class="settings-chips">
        <button class="settings-chip" onClick={() => void importTheme()}>
          Import theme…
        </button>
        <button class="settings-chip" onClick={() => void exportTheme()}>
          Export theme…
        </button>
        <button
          class="settings-chip"
          disabled={themeText(iconTheme()) === themeText(PLAIN_THEME)}
          onClick={() => replace(PLAIN_THEME, "Back to Perli's icons.")}
        >
          Back to Perli's icons
        </button>
      </div>
      <Show when={note()}>
        <p class="settings-note" role="status">
          {note()}
          <Show when={before()}>
            {(theme) => (
              <button
                class="settings-chip"
                onClick={() => {
                  const back = theme();
                  setBefore(undefined);
                  setIconTheme(back);
                  setNote("Your icons are back.");
                }}
              >
                Undo
              </button>
            )}
          </Show>
        </p>
      </Show>
    </>
  );
}
