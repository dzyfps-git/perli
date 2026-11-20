// PR A1 real-app check: nested archives and their crumb badges, the Method column, the archive
// cache in Settings, the mail preview, tag Undo, folder templates, the MIDI roll's windows, and
// the picture switches. CDP and page events only: the user's mouse and keyboard are never
// touched. Its own LOCALAPPDATA, TEMP and USERNAME keep it away from the user's own Perli.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = new URL(".", import.meta.url);
// The release build `npx tauri build --no-bundle` made, wherever Cargo puts its target folder.
const exe =
  process.env.PERLI_EXE ??
  join(JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: fileURLToPath(new URL("../../src-tauri/", here)) })).target_directory, "release", "perli.exe");
const shots = new URL("./shots-a1/", here);
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "perli-a1-"));
const tag = basename(root);
const [data, home, temp] = [join(root, "data"), join(root, "home"), join(root, "temp")];
const templates = join(data, "com.dzyfps.perli", "templates");
for (const folder of [data, home, temp]) mkdirSync(folder, { recursive: true });
execFileSync("python", ["-I", fileURLToPath(new URL("./a1-files.py", here)), home, templates], { stdio: "inherit" });

const PORT = 9452;
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
const targets = () => fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => []);
async function waitFor(test, most = 8000) {
  for (let waited = 0; waited < most; waited += 250) {
    if (await test().catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

const logs = [];
/** Each IPC call the page makes, as [command, its arguments as JSON]. */
const calls = [];
let ws;
let id = 0;
const pending = new Map();
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
const invoke = (cmd, args = {}) => js(`__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const shot = async (name, wait = 600) => {
  await sleep(wait);
  const s = await send("Page.captureScreenshot", { format: "png" });
  if (s.data) writeFileSync(new URL(name, shots), Buffer.from(s.data, "base64"));
};

const W_HELPERS = `window.Q = {
  crumbs: () => [...document.querySelectorAll('.panes:not([hidden]) .pane .crumb')].map((c) => c.firstChild?.textContent ?? c.textContent),
  badges: () => [...document.querySelectorAll('.panes:not([hidden]) .pane .crumb .crumb-zip')].map((b) => b.closest('.crumb').firstChild.textContent),
  preview: () => document.querySelector('dialog.quick-preview[open]'),
  settings: () => document.querySelector('section.settings-page:not([hidden])'),
  button: (box, label) => [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === label || b.getAttribute('aria-label') === label),
  hasDot: (name) => !!P.row(name)?.querySelector('.tag-dot, .tag-pill'),
  sideTags: () => [...document.querySelectorAll('.place-tag .place-label')].map((l) => l.textContent),
};
"ok";`;

let app;
let exited;
async function connect() {
  let listed = [];
  await waitFor(async () => (listed = await targets()).some((t) => t.type === "page"), 20000);
  ws = new WebSocket(listed.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = ({ data: text }) => {
    const m = JSON.parse(text);
    if (m.id) return pending.get(m.id)?.(m.result ?? m.error);
    if (m.method === "Log.entryAdded") logs.push(`${m.params.entry.level}: ${m.params.entry.text}`);
    if (m.method === "Network.requestWillBeSent" && m.params.request.url.includes("ipc.localhost")) calls.push([decodeURIComponent(m.params.request.url.split("/").pop()), m.params.request.postData ?? ""]);
  };
  await send("Log.enable");
  await send("Network.enable");
}
async function prime() {
  await js(readFileSync(new URL("./helpers.js", here), "utf8"));
  await js(W_HELPERS);
  await js(`window.__errors = []; window.addEventListener('error', (e) => __errors.push(e.message)); window.addEventListener('unhandledrejection', (e) => __errors.push(String(e.reason))); const realError = console.error; console.error = (...all) => { __errors.push('console: ' + all.map(String).join(' ')); realError(...all); };`);
}
async function start() {
  app = spawn(exe, [], { stdio: "ignore", env });
  exited = new Promise((r) => app.once("exit", r));
  await connect();
  await sleep(2600);
  await prime();
  await invoke("plugin:window|set_position", { label: "main", value: { Physical: { x: -1700, y: 120 } } }).catch((e) => note("place", String(e)));
}
async function stop() {
  await js(`document.querySelector('.window-close').click()`).catch(() => undefined);
  const gone = await Promise.race([exited.then(() => true), sleep(8000).then(() => false)]);
  ws?.close();
  if (!gone) {
    console.log("     window didn't close; killed");
    app.kill();
    await exited;
  }
}
const goTo = async (path) => {
  await js(`P.wkey('l', { ctrlKey: true })`);
  await sleep(300);
  await js(`(() => { const i = document.querySelector('.panes:not([hidden]) .pane .path-input'); P.type(i, ${JSON.stringify(path)}); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  await sleep(1200);
};
const names = () => js(`P.names()`);
const sorted = async () => (await names()).slice().sort();
const part = async (name, run) => {
  if (process.env.ONLY && !process.env.ONLY.split(",").some((o) => name.startsWith(o))) return;
  console.log(`---- ${name}`);
  try {
    await run();
  } catch (error) {
    failed++;
    console.log(`FAIL ${name} crashed: ${error.message}`);
  }
  await js(`(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); for (const p of document.querySelectorAll(':popover-open')) p.hidePopover(); document.querySelector('section.settings-page:not([hidden]) .settings-done')?.click(); P.closeMenus(); })()`).catch(() => undefined);
  await sleep(500);
  note("errors", await js(`__errors.splice(0)`).catch(() => "page gone"));
  note("logs", logs.splice(0).filter((l) => !/^(info|verbose)/.test(l)));
};
const palette = async (label) => {
  await js(`P.wkey('p', { ctrlKey: true })`);
  await sleep(400);
  await js(`P.type(document.querySelector('.palette-input'), ${JSON.stringify(label)})`);
  await sleep(600);
  await js(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
};
const preview = async (name) => {
  await js(`P.click(${JSON.stringify(name)})`);
  await sleep(300);
  await js(`P.key(' ')`);
  return waitFor(() => js(`!!Q.preview()`), 4000);
};
const openSettings = async () => {
  await js(`P.wkey(',', { ctrlKey: true })`);
  return waitFor(() => js(`!!Q.settings()`), 4000);
};

try {
  // A tag to work with, made before the page reads its tags.
  await start();
  await invoke("create_tag", { name: "Checked", color: 1 });
  await js(`location.reload()`);
  await sleep(3500);
  await prime();
  check("window on second monitor", (await js("screenX")) < 0, true);
  await goTo(home);

  await part("nested archives", async () => {
    await js(`P.dbl('outer.zip')`);
    await waitFor(async () => (await names()).includes("in"), 4000);
    check("the outer archive opens", await sorted(), ["bz.txt", "in", "x.zip"]);
    check("one badge, on the archive", await js(`Q.badges()`), ["outer.zip"]);
    await js(`P.dbl('in')`);
    await waitFor(async () => (await names()).includes("b.zip"), 4000);
    await js(`P.dbl('b.zip')`);
    check("an archive inside it opens as a folder", await waitFor(async () => (await names()).includes("docs"), 5000), true);
    check("a badge for each level", await js(`Q.badges()`), ["outer.zip", "b.zip"]);
    await js(`P.dbl('docs')`);
    await waitFor(async () => (await names()).includes("a.txt"), 4000);
    check("and its folders open too", await names(), ["a.txt"]);
    check("the badges stay on their crumbs", await js(`Q.badges()`), ["outer.zip", "b.zip"]);
    await shot("a1-nested.png", 300);

    await goTo(join(home, "outer.zip", "x.zip"));
    check("a folder named like an archive stays a folder", await names(), ["y.txt"]);
    check("with no badge of its own", await js(`Q.badges()`), ["outer.zip"]);

    await goTo(join(home, "outer.zip", "in"));
    check("the preview of an archive inside one offers to open it", await preview("b.zip"), true);
    await waitFor(() => js(`!!Q.preview().querySelector('.archive-view')`), 4000);
    note("nested peek", await js(`Q.preview().querySelector('.archive-view')?.textContent.slice(0, 120)`));
    check("and lists what it holds", await js(`Q.preview().querySelector('.archive-view').textContent.includes('docs')`), true);
    await js(`Q.preview().close()`);
    await sleep(400);

    await goTo(join(home, "outer.zip", "in", "b.zip"));
    await palette("Extract all");
    const out = () => [join(home, "docs", "a.txt"), join(home, "b", "docs", "a.txt")].find(existsSync);
    check("Extract all lands beside the outer archive, not in the cache", await waitFor(async () => !!out(), 8000), true);
    note("landed", out());
  });

  await part("method column", async () => {
    await goTo(home);
    await preview("outer.zip");
    await waitFor(() => js(`!!Q.preview().querySelector('.archive-view th')`), 4000);
    const heads = await js(`[...Q.preview().querySelectorAll('.archive-view th')].map((h) => h.textContent)`);
    note("heads", heads);
    check("the peek has a Method column", heads.some((h) => h.startsWith("Method")), true);
    const rare = await js(`[...Q.preview().querySelectorAll('td.archive-method[data-rare]')].map((t) => t.textContent)`);
    note("rare", rare);
    check("a rare method is marked", rare.length > 0, true);
    await shot("a1-method.png", 300);
  });

  await part("archive cache", async () => {
    await openSettings();
    const size = () => js(`Q.settings().querySelector('.settings-cache-size')?.textContent`);
    await waitFor(async () => !(await size())?.startsWith("Adding"), 4000);
    note("cache", await size());
    check("Settings shows what was taken out", /taken out$/.test(await size()) && !(await size()).startsWith("Nothing"), true);
    check("in the check's own temp folder", existsSync(join(temp, "perli-zip")), true);
    await js(`Q.button(Q.settings().querySelector('.settings-cache'), 'Clear').click()`);
    await waitFor(async () => (await size()) === "Nothing taken out", 4000);
    check("Clear empties it", await size(), "Nothing taken out");
  });

  await part("mail", async () => {
    await goTo(home);
    await preview("mail.eml");
    check("a mail shows as a mail", await waitFor(() => js(`!!Q.preview().querySelector('.mail-view')`), 4000), true);
    check("with its subject", await js(`Q.preview().querySelector('.mail-subject').textContent`), "Check mail");
    check("and its attachment", await js(`[...Q.preview().querySelectorAll('.mail-attachment-name')].map((n) => n.textContent)`), ["hello.txt"]);
    await shot("a1-mail.png", 300);
    await js(`Q.button(Q.preview(), 'Save attachments').click()`);
    check("Save attachments puts it beside the mail", await waitFor(async () => existsSync(join(home, "hello.txt")), 6000), true);
    check("whole", existsSync(join(home, "hello.txt")) && readFileSync(join(home, "hello.txt"), "utf8"), "hello from the mail");
  });

  await part("tags", async () => {
    await goTo(home);
    check("the tag is in the sidebar", await js(`Q.sideTags()`), ["Checked"]);
    await js(`P.click('a.txt')`);
    await js(`P.key('1', { altKey: true, code: 'Digit1' })`);
    check("Alt+1 tags the file", await waitFor(() => js(`Q.hasDot('a.txt')`), 4000), true);
    await js(`P.key('z', { ctrlKey: true, code: 'KeyZ' })`);
    check("Undo takes the tag off", await waitFor(() => js(`!Q.hasDot('a.txt')`), 4000), true);
    await js(`P.click('a.txt')`);
    await js(`P.key('1', { altKey: true, code: 'Digit1' })`);
    await waitFor(() => js(`Q.hasDot('a.txt')`), 4000);

    await js(`P.menu(document.querySelector('.place-tag'))`);
    await waitFor(() => js(`!!document.querySelector('.menu')`), 2000);
    await js(`[...document.querySelector('.menu').querySelectorAll('button')].find((b) => b.textContent.includes('Delete tag')).click()`);
    await waitFor(() => js(`!!document.querySelector('dialog.confirm[open]')`), 3000);
    note("confirm", await js(`document.querySelector('dialog.confirm[open] .confirm-summary')?.textContent`));
    await js(`document.querySelector('dialog.confirm[open] .confirm-delete').click()`);
    check("Delete tag takes it from the sidebar", await waitFor(async () => (await js(`Q.sideTags()`)).length === 0, 4000), true);
    check("and off the file", await waitFor(() => js(`!Q.hasDot('a.txt')`), 4000), true);
    await js(`P.click('a.txt')`);
    await js(`P.key('z', { ctrlKey: true, code: 'KeyZ' })`);
    check("Undo brings the tag back", await waitFor(async () => (await js(`Q.sideTags()`)).includes("Checked"), 4000), true);
    check("on the file too", await waitFor(() => js(`Q.hasDot('a.txt')`), 4000), true);
    await shot("a1-tags.png", 300);
  });

  await part("templates", async () => {
    await goTo(home);
    await js(`P.bgMenu()`);
    await waitFor(() => js(`!!document.querySelector('.menu')`), 2000);
    await js(`[...document.querySelector('.menu').querySelectorAll('button')].find((b) => b.textContent.includes('New…')).click()`);
    await waitFor(() => js(`!!document.querySelector('.new-gallery:popover-open')`), 3000);
    await waitFor(() => js(`[...document.querySelectorAll('.new-gallery .new-label')].some((l) => l.textContent === 'Project {name}')`), 4000);
    const tiles = await js(`[...document.querySelectorAll('.new-gallery .new-tile')].map((t) => [t.querySelector('.new-label')?.textContent, t.querySelector('.new-note')?.textContent ?? null])`);
    note("tiles", tiles);
    check("the folder template asks a name first", tiles.find((t) => t[0] === "Project {name}")?.[1], "Name it first");
    await js(`[...document.querySelectorAll('.new-gallery .new-tile')].find((t) => t.querySelector('.new-label')?.textContent === 'Project {name}').click()`);
    check("Name it opens", await waitFor(() => js(`!!document.querySelector('.new-gallery .new-naming')`), 3000), true);
    await shot("a1-name-it.png", 300);
    await js(`P.type(document.querySelector('.new-naming input'), 'Alpha')`);
    await js(`Q.button(document.querySelector('.new-naming'), 'Make it').click()`);
    const made = join(home, "Project Alpha", "Alpha notes.txt");
    check("the folder lands whole, with the name in every name", await waitFor(async () => existsSync(made), 6000), true);
    await sleep(600);
    check("with no rename box after", await js(`!!document.querySelector('.panes:not([hidden]) .pane .file-grid input')`), false);

    await openSettings();
    await waitFor(() => js(`Q.settings().querySelectorAll('.template-row').length > 0`), 4000);
    check("Settings lists the templates", await js(`[...Q.settings().querySelectorAll('.template-name')].map((b) => b.textContent).sort()`), ["Project {name}", "plain.txt"]);
    await js(`Q.settings().querySelector('[aria-label="Rename the template plain.txt"]').click()`);
    await waitFor(() => js(`!!Q.settings().querySelector('.template-row input')`), 2000);
    check("rename picks the name up to its type", await js(`(() => { const i = Q.settings().querySelector('.template-row input'); return i.value.slice(i.selectionStart, i.selectionEnd); })()`), "plain");
    await js(`(() => { const i = Q.settings().querySelector('.template-row input'); P.type(i, 'renamed.txt'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    check("a template renames", await waitFor(async () => existsSync(join(templates, "renamed.txt")) && !existsSync(join(templates, "plain.txt")), 4000), true);
    check("and the list follows", await waitFor(async () => (await js(`[...Q.settings().querySelectorAll('.template-name')].map((b) => b.textContent)`)).includes("renamed.txt"), 3000), true);
    // Remove goes through the real Recycle Bin, so it is left to the Rust test and the user.
  });

  await part("midi", async () => {
    await goTo(home);
    calls.splice(0);
    await preview("song.mid");
    check("the song shows its roll", await waitFor(() => js(`!!Q.preview().querySelector('.midi-stage')`), 6000), true);
    await sleep(1200);
    const song = calls.filter((c) => c[0].startsWith("song_") && c[1]);
    note("song calls", song);
    note("all calls", [calls.length, calls.slice(0, 8).map((c) => c[0])]);
    const notes = song.filter((c) => c[0] === "song_notes").map((c) => JSON.parse(c[1]));
    check("the roll asks for a window of notes, not all", notes.length > 0 && notes.every((n) => typeof n.from === "number" && n.to - n.from <= 120), true);
    check("the strip asks for an overview", song.some((c) => c[0] === "song_overview" && JSON.parse(c[1]).columns === 1200), true);
    const painted = await js(`(() => { const c = Q.preview().querySelector('canvas.lane-ahead'); if (!c) return 'none'; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let on = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) on++; return on > 0; })()`);
    check("the strip is painted from it", painted, true);
    await shot("a1-midi.png", 300);
  });

  await part("picture switches", async () => {
    await goTo(home);
    await preview("pic.png");
    await waitFor(() => js(`!!Q.preview().querySelector('[aria-label="Picture tools"]')`), 4000);
    await js(`Q.preview().querySelector('button[aria-label="Picture tools"]').click()`);
    await waitFor(() => js(`!!document.querySelector('.picture-tools-panel:popover-open')`), 3000);
    const switches = () => js(`[...document.querySelectorAll('.picture-tools-panel .picture-tools-switches .switch-row')].map((s) => [s.querySelector('.switch-label').textContent, s.getAttribute('aria-checked'), s.disabled])`);
    const before = await switches();
    note("switches", before);
    check("camera facts on and the place off, by default", before, [
      ["Keep camera facts in copies", "true", false],
      ["Remove location from copies", "true", false],
    ]);
    await js(`document.querySelector('.picture-tools-panel .switch-row').click()`);
    await sleep(300);
    check("with no facts kept, the place switch has nothing to do", (await switches())[1].slice(2), [true]);
    await shot("a1-picture.png", 300);
    await js(`document.querySelector('.picture-tools-panel .switch-row').click()`);
  });
} finally {
  console.log(failed ? `${failed} FAILED` : "all ok");
  await stop().catch(() => undefined);
  await sleep(1500);
  rmSync(root, { recursive: true, force: true });
}
