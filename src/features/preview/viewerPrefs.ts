import type { CogItem } from "../../ui/Controls";
import { saved, stored } from "../filelist/prefs";

/** What each viewer remembers between files. They live here, apart from the viewers, so the
 *  settings page can show them without loading a viewer. */

export const [spread, setSpread] = stored("comic-spread", saved("comic-spread") === true);
export const [manga, setManga] = stored("comic-manga", saved("comic-manga") === true);
export const [strip, setStrip] = stored("comic-strip", saved("comic-strip") !== false);
export const [contentsOpen, setContentsOpen] = stored("doc-contents", saved("doc-contents") === true);
export const [grid, setGrid] = stored("model-grid", saved("model-grid") === true);
export const [light, setLight] = stored("model-light", saved("model-light") === true);
export const [playNext, setPlayNext] = stored("song-play-next", saved("song-play-next") === true);
export const [wrap, setWrap] = stored("text-wrap", saved("text-wrap") === true);
export const [numbers, setNumbers] = stored("text-lines", saved("text-lines") !== false);
export const [asTable, setAsTable] = stored("text-table", saved("text-table") !== false);
/** Each pixel of a picture stays a hard square when zoomed in, instead of being smoothed. */
export const [sharpPixels, setSharpPixels] = stored("picture-sharp", saved("picture-sharp") === true);

const item = (label: string, checked: () => boolean, set: (on: boolean) => void): CogItem => ({
  label,
  checked,
  toggle: () => set(!checked()),
});

/** The settings of each viewer, as its cog and the settings page both show them. */
export const VIEWER_SETTINGS = {
  Pictures: [item("Sharp pixels when zoomed in", sharpPixels, setSharpPixels)],
  Text: [
    item("Wrap long lines", wrap, setWrap),
    item("Line numbers", numbers, setNumbers),
    item("Open tables as a table", asTable, setAsTable),
  ],
  "Documents and books": [item("Contents open", contentsOpen, setContentsOpen)],
  Comics: [
    item("Two pages side by side", spread, setSpread),
    item("Right to left, for manga", manga, setManga),
    item("Page strip", strip, setStrip),
  ],
  "3D models": [item("Floor grid", grid, setGrid), item("Light backdrop", light, setLight)],
  Music: [item("Play the next song when one ends", playNext, setPlayNext)],
} satisfies Record<string, CogItem[]>;
