// The real-app check harness: it starts the release build with its own LOCALAPPDATA, TEMP and
// USERNAME, away from the user's own Perli, drives it over CDP and page events only (the user's
// mouse and keyboard are never touched), and prints ok or FAIL for each step. run.mjs puts it in
// front of one set's parts, such as c.mjs, and names the result after that set.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = new URL(".", import.meta.url);
// The release build `npx tauri build --no-bundle` made, wherever Cargo puts its target folder.
const exe =
  process.env.PERLI_EXE ??
  join(JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: fileURLToPath(new URL("../../src-tauri/", here)) })).target_directory, "release", "perli.exe");
/** Which set of parts this is: a2, b or c, from the file run.mjs made. */
const set = basename(fileURLToPath(import.meta.url), ".built.mjs");
const shots = new URL(`./shots-${set}/`, here);
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(tmpdir(), `perli-${set}-`));
const tag = basename(root);
const [data, home, temp] = [join(root, "data"), join(root, "home"), join(root, "temp")];
for (const folder of [data, home, temp]) mkdirSync(folder, { recursive: true });
// A name nothing else on the PC has, for the index part to search for.
const probe = `perliprobe${tag.replace(/\W/g, "")}`;
execFileSync("python", ["-I", fileURLToPath(new URL(`./${set}-files.py`, here)), home, probe], { stdio: "inherit" });

const PORT = 9452;
const SPOT = { x: -1700, y: 120, width: 1300, height: 860 };
const env = {
  ...process.env,
  USERNAME: `perli-check-${tag}`,
  LOCALAPPDATA: data,
  TEMP: temp,
  TMP: temp,
  WEBVIEW2_USER_DATA_FOLDER: data,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
};

let failed = 0;
function check(name, got, wanted) {
  const ok = JSON.stringify(got) === JSON.stringify(wanted);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(got)}, want ${JSON.stringify(wanted)}`}`);
}
const note = (name, value) => console.log(`     ${name}`, JSON.stringify(value));
const pages = () =>
  fetch(`http://127.0.0.1:${PORT}/json`)
    .then((r) => r.json())
    .then((all) => all.filter((t) => t.type === "page"))
    .catch(() => []);
async function waitFor(test, most = 8000) {
  for (let waited = 0; waited < most; waited += 250) {
    if (await test().catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

const logs = [];
/** A page over CDP: its own socket, and a way to run code in it. */
async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, no) => ((ws.onopen = r), (ws.onerror = no)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data: text }) => {
    const m = JSON.parse(text);
    if (m.id) return pending.get(m.id)?.(m.result ?? m.error);
    if (m.method === "Log.entryAdded") logs.push(`${m.params.entry.level}: ${m.params.entry.text}`);
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      pending.set(++id, res);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => res({ timedOut: true }), 8000);
    });
  const js = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "js failed");
    return r.result?.value;
  };
  await send("Log.enable");
  return { id: target.id, ws, send, js, close: () => ws.close() };
}

const W_HELPERS = `window.Q = {
  panes: () => [...document.querySelectorAll('.panes:not([hidden]) .pane')],
  crumbs: (pane = Q.active()) => [...pane.querySelectorAll('.crumb')].map((c) => c.firstChild?.textContent ?? c.textContent),
  active: () => document.querySelector('.panes:not([hidden]) .pane.pane-active') ?? Q.panes()[0],
  preview: () => document.querySelector('dialog.quick-preview[open]'),
  button: (box, label) => [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === label || b.getAttribute('aria-label') === label),
  rowsOf: (pane) => [...pane.querySelectorAll('.file-grid .file-row')].filter((r) => !r.hasAttribute('data-empty')),
  marks: (pane) => Object.fromEntries(Q.rowsOf(pane).map((r) => [P.rowName(r), r.dataset.compare ?? null])),
  counts: (pane) => [...pane.querySelectorAll('.compare-bar .compare-count')].map((b) => b.textContent.trim()),
  bar: (pane, label) => [...pane.querySelectorAll('.compare-bar button')].find((b) => b.textContent.trim().startsWith(label)),
  git: () => Object.fromEntries(P.rows().map((r) => [P.rowName(r), r.dataset.git ?? null])),
  label: () => __TAURI_INTERNALS__.metadata.currentWindow.label,
  here: (pane = Q.active()) => pane.querySelector('.crumb[aria-current]')?.firstChild?.textContent ?? null,
  confirm: () => document.querySelector('dialog.confirm[open]'),
};
"ok";`;

let app;
let exited;
/** The page in use: the main window's, unless a part says otherwise. */
let page;
const js = (expression) => page.js(expression);
const invoke = (cmd, args = {}) => js(`__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const shot = async (name, wait = 600) => {
  await sleep(wait);
  const s = await page.send("Page.captureScreenshot", { format: "png" });
  if (s.data) writeFileSync(new URL(name, shots), Buffer.from(s.data, "base64"));
};

async function prime(on = page) {
  await on.js(readFileSync(new URL("./helpers.js", here), "utf8"));
  await on.js(W_HELPERS);
  await on.js(`if (!window.__errors) { window.__errors = []; window.addEventListener('error', (e) => __errors.push(e.message)); window.addEventListener('unhandledrejection', (e) => __errors.push(String(e.reason))); const realError = console.error; console.error = (...all) => { __errors.push('console: ' + all.map(String).join(' ')); realError(...all); }; }`);
}
/** Each page open now, attached and primed, with its window's label. */
async function every() {
  const found = [];
  for (const target of await pages()) {
    const one = await attach(target);
    await prime(one);
    one.label = await one.js(`Q.label()`);
    found.push(one);
  }
  return found;
}
async function start() {
  app = spawn(exe, [], { stdio: "ignore", env });
  exited = new Promise((r) => app.once("exit", r));
  await waitFor(async () => (await pages()).length > 0, 20000);
  await sleep(2600);
  const all = await every();
  page = all.find((one) => one.label === "main") ?? all[0];
  for (const other of all) if (other !== page) other.close();
  await invoke("plugin:window|set_position", { label: "main", value: { Physical: { x: SPOT.x, y: SPOT.y } } }).catch((e) => note("place", String(e)));
}
/**
 * Every process the harness started: the app and each window it opened since, which is a process
 * of its own started by it. A Perli the user runs, of this build too, is left be.
 */
const killAll = () => {
  if (!app?.pid) return;
  const tree = `$all = Get-CimInstance Win32_Process; $mine = @(${app.pid}); do { $more = @($all | Where-Object { $mine -contains $_.ParentProcessId -and $mine -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId }); $mine += $more } while ($more.Count); $mine | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`;
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", tree]);
  } catch {}
};
async function stop() {
  for (const one of await every().catch(() => [])) await one.js(`document.querySelector('.window-close').click()`).catch(() => undefined);
  const gone = await Promise.race([exited.then(() => true), sleep(8000).then(() => false)]);
  page?.close();
  if (!gone) {
    console.log("     window didn't close; killed");
    app.kill();
    await exited;
  }
}
const key = (k, init = {}) => js(`P.key(${JSON.stringify(k)}, ${JSON.stringify(init)})`);
const wkey = (k, init = {}) => js(`P.wkey(${JSON.stringify(k)}, ${JSON.stringify(init)})`);
const goTo = async (path) => {
  await wkey("l", { ctrlKey: true, code: "KeyL" });
  await sleep(300);
  await js(`(() => { const i = Q.active().querySelector('.path-input'); P.type(i, ${JSON.stringify(path)}); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  await sleep(1200);
};
const names = () => js(`P.names()`);
const part = async (name, run) => {
  if (process.env.ONLY && !process.env.ONLY.split(",").some((o) => name.startsWith(o))) return;
  console.log(`---- ${name}`);
  try {
    await run();
  } catch (error) {
    failed++;
    console.log(`FAIL ${name} crashed: ${error.message}`);
  }
  await js(`(() => { document.querySelector('.palette-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); for (const d of document.querySelectorAll('dialog[open]')) d.close(); for (const p of document.querySelectorAll(':popover-open')) p.hidePopover(); P.closeMenus(); })()`).catch(() => undefined);
  await sleep(500);
  note("errors", await js(`__errors.splice(0)`).catch(() => "page gone"));
  note("logs", logs.splice(0).filter((l) => !/^(info|verbose)/.test(l)));
};
/** Runs the palette command named exactly so. */
const pick = async (label, on = page) => {
  await on.js(`document.activeElement?.blur?.()`);
  await on.js(`P.wkey('p', { ctrlKey: true, code: 'KeyP' })`);
  await sleep(400);
  await on.js(`P.type(document.querySelector('.palette-input'), ${JSON.stringify(label)})`);
  const found = await waitFor(() => on.js(`[...document.querySelectorAll('.palette-option')].some((o) => o.querySelector('.palette-name')?.textContent === ${JSON.stringify(label)})`), 3000);
  if (!found) {
    note("palette had", await on.js(`[...document.querySelectorAll('.palette-option .palette-name')].map((n) => n.textContent).slice(0, 8)`));
    await on.js(`document.querySelector('.palette-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    throw new Error(`no palette command "${label}"`);
  }
  await on.js(`[...document.querySelectorAll('.palette-option')].find((o) => o.querySelector('.palette-name')?.textContent === ${JSON.stringify(label)}).click()`);
  await sleep(500);
};
const menuPick = async (target, label) => {
  await js(`P.menu(${JSON.stringify(target)})`);
  await waitFor(() => js(`!!P.menuItem(${JSON.stringify(label)})`), 2000);
  await js(`P.menuItem(${JSON.stringify(label)}).click()`);
  await sleep(400);
};
const preview = async (name) => {
  await js(`P.click(${JSON.stringify(name)})`);
  await sleep(300);
  await key(" ");
  return waitFor(() => js(`!!Q.preview()`), 4000);
};
const inPreview = (k, init = {}) => js(`Q.preview().dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(init)} }))`);

