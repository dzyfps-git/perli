// Measures the release build on this PC and compares it with budgets.json. Runs at phase ends.
// Run `npm run tauri build` first. Perli's window opens and closes several times.
//
// Usage: node scripts/bench.mjs [--hdd D:\]
// Reboot test: run with --hdd D:\ --prepare-reboot, reboot, then run scripts/after-reboot.cmd.
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const FILE_COUNT = 100_000;
const FOLDER_NAME = "perli-bench-100k";
const PORT = 9333;
const START_RUNS = 6;
const SCROLL_MS = 5000;
const SETTLE_MS = 10_000;
// Attaching the debugger during startup would slow what is being measured.
const STARTUP_WAIT_MS = { normal: 3000, capped: 6000 };
const FRAME_LIMIT_MS = 16.7;
const CPU_SLOWDOWN = 4;

const budgets = JSON.parse(readFileSync("budgets.json", "utf8"));
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", "src-tauri/Cargo.toml"],
    { encoding: "utf8" },
  ),
);
const exe = join(metadata.target_directory, "release", "perli.exe");
if (!existsSync(exe)) throw new Error(`Build first: ${exe} is missing`);

const DEBUG_ARGS = `--remote-debugging-port=${PORT}`;
// Keeps frames running when another window covers Perli. These flags slow startup, so only
// the scroll test uses them.
const SCROLL_ARGS = [
  DEBUG_ARGS,
  "--disable-features=CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
].join(" ");
process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = DEBUG_ARGS;

const median = (values) => percentile(values, 50);

function percentile(values, percent) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1)];
}

function createTestFolder(root) {
  const folder = join(root, FOLDER_NAME);
  mkdirSync(folder, { recursive: true });
  const extensions = ["txt", "jpg", "png", "pdf", "docx", "mp4", "zip", "json"];
  for (let i = readdirSync(folder).length; i < FILE_COUNT; i++) {
    const name = `Test file ${i} with a realistic length.${extensions[i % extensions.length]}`;
    writeFileSync(join(folder, name), "");
  }
  return folder;
}

function deleteTestFolder(folder) {
  if (basename(folder) !== FOLDER_NAME) throw new Error(`Refusing to delete ${folder}`);
  rmSync(folder, { recursive: true, force: true });
}

async function launch(folder, capped) {
  if (capped) {
    const { stdout } = await promisify(execFile)("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/run-capped.ps1", "-Exe", exe, "-Folder", folder,
    ]);
    const [startedAt, pid] = stdout.trim().split(/\s+/).map(Number);
    return { startedAt, pid };
  }
  const startedAt = Date.now();
  const child = spawn(exe, [folder], { stdio: "ignore", detached: true });
  child.unref();
  return { startedAt, pid: child.pid };
}

function close(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // It has already exited.
  }
}

class Page {
  #nextId = 1;
  #pending = new Map();

  static async connect() {
    const url = await waitFor(async () => {
      const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((response) => response.json());
      return targets.find((target) => target.type === "page")?.webSocketDebuggerUrl;
    });
    const page = new Page();
    page.socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      page.socket.onopen = resolve;
      page.socket.onerror = reject;
    });
    page.socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      page.#pending.get(message.id)?.(message.result);
      page.#pending.delete(message.id);
    };
    return page;
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.#pending.set(id, resolve));
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }
}

async function waitFor(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // Not up yet.
    }
    await sleep(20);
  }
  throw new Error("Timed out waiting for Perli");
}

const READ_TIMINGS = `(() => {
  const ready = performance.getEntriesByName("perli-ready")[0];
  const opened = performance.getEntriesByName("perli-folder-open")[0];
  return ready && {
    readyAt: performance.timeOrigin + ready.startTime,
    loadMs: opened.detail.loadMs,
    count: opened.detail.count,
  };
})()`;

async function open(folder, capped = false) {
  const { startedAt, pid } = await launch(folder, capped);
  await sleep(capped ? STARTUP_WAIT_MS.capped : STARTUP_WAIT_MS.normal);
  const page = await Page.connect();
  const timings = await waitFor(() => page.evaluate(READ_TIMINGS));
  if (timings.count !== FILE_COUNT) throw new Error(`Expected ${FILE_COUNT} rows, got ${timings.count}`);
  return { pid, page, startMs: timings.readyAt - startedAt, loadMs: timings.loadMs };
}

async function measureStart(folder, capped) {
  const runs = [];
  for (let run = 0; run < START_RUNS; run++) {
    const { pid, page, startMs, loadMs } = await open(folder, capped);
    runs.push({ startMs, loadMs });
    page.socket.close();
    close(pid);
    await sleep(2000);
  }
  // The first run is the slowest realistic case this script can create without a reboot.
  return {
    firstMs: runs[0].startMs,
    medianMs: median(runs.slice(1).map((run) => run.startMs)),
    loadMs: median(runs.map((run) => run.loadMs)),
  };
}

// Private working set, the number Task Manager shows, for Perli and all its WebView2 processes.
function measureRamMB(pid) {
  const script = `
    $parents = @{}
    Get-CimInstance Win32_Process | ForEach-Object { $parents[[int]$_.ProcessId] = [int]$_.ParentProcessId }
    $tree = @{ ${pid} = $true }
    do {
      $added = $false
      foreach ($id in $parents.Keys) {
        if (-not $tree.ContainsKey($id) -and $tree.ContainsKey($parents[$id])) { $tree[$id] = $true; $added = $true }
      }
    } while ($added)
    $bytes = 0
    Get-CimInstance Win32_PerfRawData_PerfProc_Process | ForEach-Object {
      if ($tree.ContainsKey([int]$_.IDProcess)) { $bytes += $_.WorkingSetPrivate }
    }
    "$bytes $($tree.Count)"`;
  const [bytes, processes] = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" })
    .trim()
    .split(/\s+/)
    .map(Number);
  return { mb: bytes / 1024 / 1024, processes };
}

const toggleOverlay = `window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true }))`;

// Scrolls the list once per frame and records every frame time.
const scrollScript = (step) => `new Promise((resolve) => {
  const grid = document.querySelector('[role="grid"]');
  const limit = grid.scrollHeight - grid.clientHeight;
  const frames = [];
  let blank = 0;
  let direction = 1;
  let last = performance.now();
  const end = last + ${SCROLL_MS};
  function tick(now) {
    frames.push(now - last);
    last = now;
    if (grid.querySelector("[data-empty]")) blank++;
    if (grid.scrollTop + ${step} > limit || grid.scrollTop - ${step} < 0) direction = grid.scrollTop < limit / 2 ? 1 : -1;
    grid.scrollTop += ${step} * direction;
    if (now < end) requestAnimationFrame(tick);
    else resolve({ frames: frames.slice(1), blank });
  }
  requestAnimationFrame(tick);
})`;

async function measureScroll(page, step) {
  const { frames, blank } = await page.evaluate(scrollScript(step));
  return {
    frames: frames.length,
    p50Ms: percentile(frames, 50),
    p99Ms: percentile(frames, 99),
    maxMs: Math.max(...frames),
    overLimit: frames.filter((frame) => frame > FRAME_LIMIT_MS).length,
    blank,
  };
}

async function measureSlowed(page) {
  const scroll = {};
  scroll.slowed = await measureScroll(page, 84);
  // Very fast scrolling varies a lot between runs, so this keeps the middle of three.
  const fastRuns = [];
  for (let run = 0; run < 3; run++) fastRuns.push(await measureScroll(page, 1200));
  scroll.slowedFast = fastRuns.sort((a, b) => a.p99Ms - b.p99Ms)[1];
  await page.evaluate(toggleOverlay);
  await sleep(300);
  scroll.slowedGlass = await measureScroll(page, 84);
  await page.evaluate(toggleOverlay);
  return scroll;
}

// CPU throttling only slows the renderer's main thread, so this slows the whole process tree.
async function measureCappedScroll(folder) {
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = SCROLL_ARGS;
  const { pid, page } = await open(folder, true);
  const scroll = await measureSlowed(page);
  page.socket.close();
  close(pid);
  return scroll;
}

async function measureRunning(folder) {
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = SCROLL_ARGS;
  const { pid, page } = await open(folder);
  await sleep(SETTLE_MS);
  const idle = measureRamMB(pid);

  const scroll = {};
  scroll.normal = await measureScroll(page, 84);
  await page.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
  Object.assign(scroll, await measureSlowed(page));
  await page.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  await sleep(SETTLE_MS);
  const afterScroll = measureRamMB(pid);
  page.socket.close();
  close(pid);
  return { idle, afterScroll, scroll };
}

function installerMB() {
  const nsisDir = join(metadata.target_directory, "release", "bundle", "nsis");
  const installer = readdirSync(nsisDir).find((name) => name.endsWith(".exe"));
  return statSync(join(nsisDir, installer)).size / 1024 / 1024;
}

const hddIndex = process.argv.indexOf("--hdd");
const hddRoot = hddIndex > 0 ? process.argv[hddIndex + 1] : undefined;

if (process.argv.includes("--prepare-reboot")) {
  createTestFolder(tmpdir());
  createTestFolder(hddRoot);
  console.log("Ready. Reboot, then run scripts/after-reboot.cmd.");
  process.exit();
}

if (process.argv.includes("--after-reboot")) {
  const ssdFolder = join(tmpdir(), FOLDER_NAME);
  const hddFolder = join(hddRoot, FOLDER_NAME);
  const once = async (folder) => {
    const { pid, page, startMs, loadMs } = await open(folder);
    page.socket.close();
    close(pid);
    await sleep(2000);
    return { startMs, loadMs };
  };
  const results = {
    firstLaunch: await once(ssdFolder),
    hddUncached: await once(hddFolder),
    hddCached: await once(hddFolder),
  };
  mkdirSync("bench-results", { recursive: true });
  writeFileSync(join("bench-results", "after-reboot.json"), JSON.stringify(results, null, 2));
  deleteTestFolder(ssdFolder);
  deleteTestFolder(hddFolder);
  console.log(JSON.stringify(results, null, 2));
  process.exit();
}

console.log("Creating test folder...");
const ssdFolder = createTestFolder(tmpdir());
const hddFolder = hddRoot && createTestFolder(hddRoot);

let results;
try {
  console.log("Measuring startup...");
  const start = await measureStart(ssdFolder, false);
  console.log("Measuring slowed startup...");
  const slowedStart = await measureStart(ssdFolder, true);
  const hddStart = hddFolder && (await measureStart(hddFolder, false));
  console.log("Measuring RAM and scrolling...");
  const running = await measureRunning(ssdFolder);
  console.log("Measuring capped scrolling...");
  const cappedScroll = await measureCappedScroll(ssdFolder);
  results = { installerMB: installerMB(), start, slowedStart, hddStart, ...running, cappedScroll };
} finally {
  deleteTestFolder(ssdFolder);
  if (hddFolder) deleteTestFolder(hddFolder);
}

mkdirSync("bench-results", { recursive: true });
writeFileSync(join("bench-results", "latest.json"), JSON.stringify(results, null, 2));

const checks = [
  ["Installer (MB)", results.installerMB, budgets.installerMB],
  ["Start (ms)", results.start.medianMs, budgets.startMs],
  ["Slowed start (ms)", results.slowedStart.medianMs, budgets.slowedStartMs],
  ["Idle RAM (MB)", results.idle.mb, budgets.idleRamMB],
  ["RAM after use (MB)", results.afterScroll.mb, budgets.ramAfterUseMB],
  ["Slowed scroll p99 (ms)", results.scroll.slowed.p99Ms, budgets.scrollP99Ms],
  ["Slowed fast scroll p99 (ms)", results.scroll.slowedFast.p99Ms, budgets.fastScrollP99Ms],
];

let over = false;
for (const [name, value, budget] of checks) {
  const status = value > budget ? "OVER BUDGET" : "ok";
  over ||= value > budget;
  console.log(`${name}: ${value.toFixed(1)} (budget ${budget}) ${status}`);
}
// Report only: the job's rate control pauses the process, which real slow hardware does not do.
console.log(`Capped scroll p99 (ms): ${results.cappedScroll.slowed.p99Ms.toFixed(1)} (report only)`);
console.log(`Capped fast scroll p99 (ms): ${results.cappedScroll.slowedFast.p99Ms.toFixed(1)} (report only)`);
console.log(JSON.stringify(results, null, 2));
process.exitCode = over ? 1 : 0;
