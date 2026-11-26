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
/** Curved surfaces look curved. Off, every triangle shows as a flat face. */
export const [smooth, setSmooth] = stored("model-smooth", saved("model-smooth") !== false);
/** Which mouse buttons turn, move and zoom a model: Perli's own, or the ones another app taught. */
export type CameraStyle = "perli" | "blender" | "maya";
export const [camera, setCamera] = stored<CameraStyle>(
  "model-camera",
  (["blender", "maya"] as const).find((style) => style === saved("model-camera")) ?? "perli",
);
export const [playNext, setPlayNext] = stored("song-play-next", saved("song-play-next") === true);
export const [wrap, setWrap] = stored("text-wrap", saved("text-wrap") === true);
export const [numbers, setNumbers] = stored("text-lines", saved("text-lines") !== false);
export const [asTable, setAsTable] = stored("text-table", saved("text-table") !== false);
/** A JSON file shows as a folding tree instead of text. */
export const [asTree, setAsTree] = stored("text-tree", saved("text-tree") === true);
/** A Markdown file shows as it was written instead of as a page. */
export const [asSource, setAsSource] = stored("doc-source", saved("doc-source") === true);
/** The neighbouring files along the bottom of the preview. */
export const [neighbours, setNeighbours] = stored("preview-strip", saved("preview-strip") !== false);
/** The size the preview was last dragged to, in CSS pixels. */
export const [previewSize, setPreviewSize] = stored<{ width: number; height: number } | null>(
  "preview-size",
  ((size) => (size && size.width > 0 && size.height > 0 ? size : null))(saved("preview-size") as { width: number; height: number } | null),
);
/** Each pixel of a picture stays a hard square when zoomed in, instead of being smoothed. */
export const [sharpPixels, setSharpPixels] = stored("picture-sharp", saved("picture-sharp") === true);
/** What picture copies keep of a photo's facts: the camera on, the place off. */
export const [copyFacts, setCopyFacts] = stored("picture-copy-facts", saved("picture-copy-facts") !== false);
export const [copyNoPlace, setCopyNoPlace] = stored("picture-copy-no-place", saved("picture-copy-no-place") !== false);
export const pictureKeep = () => ({ camera: copyFacts(), place: !copyNoPlace() });
/** A PDF's own scripts run, such as a total that adds itself up, shut off from files and the web. */
/** Office files show through Office's own previewer when Windows has it. */
export const [officeHandlers, setOfficeHandlers] = stored("office-handlers", saved("office-handlers") !== false);
/** A file from the internet opens in Perli's reader first, which runs nothing and fetches nothing. */
export const [internetReader, setInternetReader] = stored("office-internet-reader", saved("office-internet-reader") !== false);
export const [pdfScripts, setPdfScripts] = stored("pdf-scripts", saved("pdf-scripts") !== false);
/** A small map of the whole picture, page or film shows while zoomed in. */
export const [minimapShown, setMinimapShown] = stored("minimap", saved("minimap") !== false);
/** A song's lyrics from the `.lrc` file beside it. */
export const [lyricsShown, setLyricsShown] = stored("song-lyrics", saved("song-lyrics") !== false);
/** A MIDI file's notes fall onto the keyboard, instead of running past it. */
export const [falling, setFalling] = stored("midi-falling", saved("midi-falling") === true);
/** A `.sf2` file of the user's own that MIDI files play through, or null for the bundled one. */
export const [soundSet, setSoundSet] = stored<string | null>("midi-font", typeof saved("midi-font") === "string" ? (saved("midi-font") as string) : null);
export const [videoMuted, setVideoMuted] = stored("video-muted", saved("video-muted") === true);
/** A film that plays when its preview closes goes on in a small window over the others. */
export const [videoPopOut, setVideoPopOut] = stored("video-pop-out", saved("video-pop-out") !== false);
/** A film's subtitles from the `.srt` or `.vtt` file beside it. */
export const [subtitles, setSubtitles] = stored("video-subtitles", saved("video-subtitles") !== false);
export type BookTheme = "auto" | "paper" | "sepia" | "night";
export const BOOK_THEMES: BookTheme[] = ["auto", "paper", "sepia", "night"];
export const [bookTheme, setBookTheme] = stored<BookTheme>("book-theme", BOOK_THEMES.find((theme) => theme === saved("book-theme")) ?? "auto");
export const [bookSerif, setBookSerif] = stored("book-serif", saved("book-serif") !== false);
export type BookWidth = "narrow" | "medium" | "wide";
export const BOOK_WIDTHS: Record<BookWidth, number> = { narrow: 560, medium: 700, wide: 900 };
export const [bookWidth, setBookWidth] = stored<BookWidth>(
  "book-width",
  (Object.keys(BOOK_WIDTHS) as BookWidth[]).find((width) => width === saved("book-width")) ?? "medium",
);
/** A book turns page by page, instead of scrolling. */
export const [bookPaged, setBookPaged] = stored("book-paged", saved("book-paged") === true);
/** A comic's pages one under another, for comics made to be scrolled. */
export const [comicLong, setComicLong] = stored("comic-long", saved("comic-long") === true);

const MOST_PROGRESS = 300;
/** How far into each book and comic the reader got, from 0 to 1, for the bar on its picture. */
export const [readProgress, setReadProgress] = stored<Record<string, number>>(
  "read-progress",
  (saved("read-progress") as Record<string, number> | null) ?? {},
);

/** Keeps how far a book or comic was read. Nothing, or the end, forgets it. */
export function keepProgress(path: string, share: number | undefined) {
  const all = { ...readProgress() };
  delete all[path];
  if (share !== undefined && share > 0.005 && share < 0.995) all[path] = Math.round(share * 1000) / 1000;
  setReadProgress(Object.fromEntries(Object.entries(all).slice(-MOST_PROGRESS)));
}

const item = (label: string, checked: () => boolean, set: (on: boolean) => void): CogItem => ({
  label,
  checked,
  toggle: () => set(!checked()),
});

/** The settings of each viewer, as its cog and the settings page both show them. */
export const VIEWER_SETTINGS = {
  Preview: [item("Neighbouring files along the bottom", neighbours, setNeighbours)],
  Pictures: [
    item("Sharp pixels when zoomed in", sharpPixels, setSharpPixels),
    item("Map of the whole picture when zoomed in", minimapShown, setMinimapShown),
    item("Keep camera facts in copies", copyFacts, setCopyFacts),
    item("Remove location from copies", copyNoPlace, setCopyNoPlace),
  ],
  Text: [
    item("Wrap long lines", wrap, setWrap),
    item("Line numbers", numbers, setNumbers),
    item("Open tables as a table", asTable, setAsTable),
    item("Open JSON as a tree", asTree, setAsTree),
  ],
  "Documents and books": [
    item("Run a PDF's own form scripts", pdfScripts, setPdfScripts),
    item("Contents open", contentsOpen, setContentsOpen),
    item("Markdown as written, not as a page", asSource, setAsSource),
    item("Books turn page by page", bookPaged, setBookPaged),
    item("Books in a serif font", bookSerif, setBookSerif),
  ],
  Office: [
    item("Show through Office's own previewer when it is there", officeHandlers, setOfficeHandlers),
    item("Files from the internet open in Perli's reader first", internetReader, setInternetReader),
  ],
  Comics: [
    item("Two pages side by side", spread, setSpread),
    item("Right to left, for manga", manga, setManga),
    item("Page strip", strip, setStrip),
    item("Long strip, one page under another", comicLong, setComicLong),
    item("Map of the whole page when zoomed in", minimapShown, setMinimapShown),
  ],
  "3D models": [
    item("Floor grid", grid, setGrid),
    item("Light backdrop", light, setLight),
    item("Smooth shading", smooth, setSmooth),
    item("Mouse as in Blender", () => camera() === "blender", (on) => setCamera(on ? "blender" : "perli")),
    item("Mouse as in Maya", () => camera() === "maya", (on) => setCamera(on ? "maya" : "perli")),
  ],
  Music: [
    item("Play the next song when one ends", playNext, setPlayNext),
    item("Lyrics beside the song", lyricsShown, setLyricsShown),
    item("MIDI notes fall onto the keyboard", falling, setFalling),
  ],
  Video: [
    item("Start muted", videoMuted, setVideoMuted),
    item("Subtitles", subtitles, setSubtitles),
    item("Keep playing in a small window when the preview closes", videoPopOut, setVideoPopOut),
    item("Map of the whole film when zoomed in", minimapShown, setMinimapShown),
  ],
} satisfies Record<string, CogItem[]>;
