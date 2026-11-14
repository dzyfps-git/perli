import type { HLJSApi, LanguageFn } from "highlight.js";

/** File extensions and the language each one is, by highlight.js's names. */
const LANGUAGE_OF: Record<string, string> = {
  bash: "bash",
  bat: "dos",
  c: "c",
  cc: "cpp",
  cfg: "ini",
  cjs: "javascript",
  cmd: "dos",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  diff: "diff",
  go: "go",
  h: "c",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  lua: "lua",
  mjs: "javascript",
  patch: "diff",
  php: "php",
  ps1: "powershell",
  psm1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

/** The language a file is written in, or nothing for plain text. */
export function languageOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? LANGUAGE_OF[name.slice(dot + 1).toLowerCase()] : undefined;
}

const LOADERS: Record<string, () => Promise<{ default: LanguageFn }>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dos: () => import("highlight.js/lib/languages/dos"),
  go: () => import("highlight.js/lib/languages/go"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  lua: () => import("highlight.js/lib/languages/lua"),
  php: () => import("highlight.js/lib/languages/php"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  python: () => import("highlight.js/lib/languages/python"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

let core: Promise<HLJSApi> | undefined;

/** Each language loads the first time a file of it is shown, so nothing costs the start. */
async function withLanguage(language: string) {
  core ??= import("highlight.js/lib/core").then((module) => module.default);
  const hljs = await core;
  if (!hljs.getLanguage(language)) hljs.registerLanguage(language, (await LOADERS[language]()).default);
  return hljs;
}

/** A piece left open is colored again with the next one, up to this much text. */
const MOST_CARRIED = 1024 * 1024;

/**
 * Colors a file piece by piece. highlight.js can't carry its state from one piece to the next,
 * so a piece that ends inside a comment or a string is colored again together with the next
 * one, and `replaces` says to take the last piece's HTML away first. highlight.js escapes the
 * text itself, so the HTML is safe.
 */
export function pieceColorer(language: string) {
  let open: string | undefined;
  return async (piece: string): Promise<{ html: string; replaces: boolean }> => {
    const replaces = open !== undefined;
    const text = (open ?? "") + piece;
    const hljs = await withLanguage(language);
    const result = hljs.highlight(text, { language, ignoreIllegals: true }) as { value: string; _top?: { parent?: unknown } };
    // The root mode has no parent, so a parent means the text ended inside something.
    open = result._top?.parent && text.length < MOST_CARRIED ? text : undefined;
    return { html: result.value, replaces };
  };
}
