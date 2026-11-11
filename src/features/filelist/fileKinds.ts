/**
 * Perli's own file icons. Each kind of file has one outline drawing and one color, and a file's
 * kind comes from its extension alone, so a row knows its icon without asking Windows.
 */

/** A sheet of paper with a folded corner, which document kinds draw their mark on. */
const PAGE = "M7 3h7l4 4v14H7zM14 3v4h4";
/** A rounded frame, for what is looked at. */
const FRAME = "M6 5h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z";
/** No hue of its own: a quiet gray. */
const PLAIN = -1;

/** Per kind: its hue on the color wheel, its drawing on a 24 by 24 grid, and its extensions. */
const KINDS = {
  folder: [PLAIN, "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", ""],
  file: [PLAIN, PAGE, ""],
  picture: [
    340,
    `${FRAME}M4 16l5-5 4 4 3-3 4 4M15.5 9h.01`,
    "png jpg jpeg jfif gif webp bmp ico tif tiff heic heif avif raw cr2 cr3 nef arw dng tga",
  ],
  video: [300, `${FRAME}M10 9.5v5l4.5-2.5z`, "mp4 mkv mov avi wmv webm m4v flv mpg mpeg m2ts 3gp"],
  audio: [
    50,
    "M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
    "mp3 flac wav ogg opus m4a aac wma aiff mid midi",
  ],
  pdf: [25, `${PAGE}M10 17.5v-6h1.5a1.75 1.75 0 0 1 0 3.5H10`, "pdf"],
  doc: [255, `${PAGE}M10 11h5M10 14h5M10 17h3`, "doc docx odt rtf pages"],
  text: [PLAIN, `${PAGE}M10 12.5h5M10 15.5h5`, "txt nfo"],
  sheet: [150, `${PAGE}M10 11h5v6h-5zM10 14h5M12.5 11v6`, "xls xlsx xlsm ods csv tsv numbers"],
  slides: [40, `${PAGE}M10 11h5v4h-5zM12.5 15v2.5`, "ppt pptx odp"],
  markdown: [230, `${PAGE}M9.5 17.5v-6l3 3.5 3-3.5v6`, "md markdown mdx rst"],
  code: [
    190,
    "M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12",
    "js mjs cjs ts tsx jsx rs py go c h cpp hpp cc cs java kt swift rb php lua dart zig vue svelte sql r",
  ],
  web: [
    215,
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z",
    "html htm xhtml css scss sass less webmanifest",
  ],
  data: [
    85,
    "M9 4c-2 0-3 1-3 3v2c0 1.5-.8 2.5-2 3 1.2.5 2 1.5 2 3v2c0 2 1 3 3 3M15 4c2 0 3 1 3 3v2c0 1.5.8 2.5 2 3-1.2.5-2 1.5-2 3v2c0 2-1 3-3 3",
    "json jsonc json5 xml yaml yml toml plist ndjson",
  ],
  archive: [70, "M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM3 4h18v4H3zM10 12h4", "zip 7z rar tar gz tgz bz2 xz zst cab"],
  app: [
    270,
    "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 9h18M6.5 6.5h.01M9.5 6.5h.01",
    "exe com appx msix",
  ],
  installer: [285, "M12 3v10M8 9l4 4 4-4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3", "msi msp"],
  library: [PLAIN, "M12 3l9 4.5-9 4.5-9-4.5zM3 12l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5", "dll sys ocx drv so lib a o pdb"],
  font: [10, "M5 19l7-15 7 15M8 13h8", "ttf otf woff woff2 ttc fon"],
  book: [120, "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11", "epub mobi azw3 fb2 djvu cbz cbr cb7"],
  model: [
    170,
    "M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9",
    "obj stl fbx gltf glb 3mf blend dae ply step stp",
  ],
  vector: [320, "M3 17h4v4H3zM17 3h4v4h-4zM5 17c0-7 5-12 12-12", "svg ai eps"],
  design: [
    265,
    "M4 10a5 5 0 1 0 10 0 5 5 0 0 0-10 0zM11 11h9v9h-9z",
    "psd psb xcf fig sketch kra afdesign afphoto indd",
  ],
  database: [
    200,
    "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
    "db sqlite sqlite3 mdb accdb dbf",
  ],
  disk: [
    240,
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
    "iso img vhd vhdx vmdk dmg wim",
  ],
  shortcut: [210, "M9 15L19 5M11 5h8v8M5 11v8h8", "lnk url"],
  script: [
    140,
    "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM7 10l3 2.5L7 15M12.5 15h4",
    "bat cmd ps1 psm1 sh bash zsh fish vbs ahk reg",
  ],
  config: [
    PLAIN,
    "M4 7h9M17 7h3M4 17h3M11 17h9M13 5v4h4V5zM7 15v4h4v-4z",
    "ini cfg conf config env properties editorconfig gitignore gitattributes inf",
  ],
  log: [PLAIN, "M5 7h.01M5 12h.01M5 17h.01M9 7h10M9 12h10M9 17h6", "log"],
  subtitle: [280, `${FRAME}M7 15h4M13 15h4M7 12h7`, "srt vtt ass ssa sub"],
  key: [95, "M14.5 9.5a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zM13 13l7 7M17 17l2-2", "pem crt cer key pfx p12 pub gpg asc"],
  mail: [235, "M4 6h16v12H4zM4 7l8 6 8-6", "eml msg pst mbox"],
} satisfies Record<string, [hue: number, drawing: string, extensions: string]>;

export type Kind = keyof typeof KINDS;

const BY_EXTENSION = new Map<string, Kind>(
  Object.entries(KINDS).flatMap(([kind, [, , extensions]]) =>
    extensions.split(" ").map((extension) => [extension, kind as Kind] as const),
  ),
);

/** Kinds whose own picture says more than any icon. */
const PICTURED: ReadonlySet<Kind> = new Set<Kind>(["picture", "video"]);

export function kindOf(name: string, isDir: boolean): Kind {
  if (isDir) return "folder";
  return BY_EXTENSION.get(name.slice(name.lastIndexOf(".") + 1).toLowerCase()) ?? "file";
}

export const hasPicture = (kind: Kind) => PICTURED.has(kind);

const color = (hue: number) =>
  hue === PLAIN
    ? "var(--text-muted)"
    : `light-dark(oklch(0.52 0.15 ${hue}), oklch(0.82 0.11 ${hue}))`;

const drawingUrl = (drawing: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${drawing}"/></svg>`,
  )}")`;

/** The style rules that give every kind its drawing and color. A folder takes the accent. */
export const iconSheet = () =>
  Object.entries(KINDS)
    .map(
      ([kind, [hue, drawing]]) =>
        `[data-kind="${kind}"]{--kind-icon:${drawingUrl(drawing)};--kind-color:${kind === "folder" ? "var(--accent)" : color(hue)}}`,
    )
    .join("\n");

const DAY_MS = 86_400_000;
const OLD_DAYS = 365;

/**
 * How old a date reads, from 0 for today to 1 for a year or more. Recent days spread out and old
 * ones crowd together, the way they matter.
 */
export function ageShare(time: number, now: number) {
  if (time <= 0) return 1;
  const days = Math.max(0, (now - time) / DAY_MS);
  return Math.min(1, Math.log1p(days) / Math.log1p(OLD_DAYS));
}
