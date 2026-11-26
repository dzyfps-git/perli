// The Office phase: Windows' own previewers hosted in Perli's preview (placed over the box, hidden
// under Perli's menus and tooltips with a picture in their place, Esc, files switched fast,
// failures falling back), and Perli's own readers for Word, Excel and PowerPoint files, files
// from the internet, locked files, and Compare of two Word documents. Windows' window is looked
// at with window calls only: nothing here moves the mouse or presses real keys.
const office = join(home, "office");
const runStarted = new Date();
const probeScript = join(root, "host.ps1");
writeFileSync(
  probeScript,
  `param([int]$Owner, [string]$Do = "look")
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class Host {
  public delegate bool Each(IntPtr w, IntPtr p);
  [DllImport("user32")] public static extern bool EnumWindows(Each e, IntPtr p);
  [DllImport("user32")] public static extern bool EnumChildWindows(IntPtr w, Each e, IntPtr p);
  [DllImport("user32")] public static extern uint GetWindowThreadProcessId(IntPtr w, out uint pid);
  [DllImport("user32")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string name);
  [DllImport("user32")] public static extern bool IsWindowVisible(IntPtr w);
  [DllImport("user32")] public static extern bool GetWindowRect(IntPtr w, out RECT r);
  [DllImport("user32")] public static extern bool GetClientRect(IntPtr w, out RECT r);
  [DllImport("user32")] public static extern bool ClientToScreen(IntPtr w, ref POINT p);
  [DllImport("user32")] public static extern IntPtr GetParent(IntPtr w);
  [DllImport("user32")] public static extern bool PostMessage(IntPtr w, uint m, IntPtr wp, IntPtr lp);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static IntPtr Find(int owner) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((w, p) => { uint pid; GetWindowThreadProcessId(w, out pid); if (pid == owner) { var h = FindWindowEx(w, IntPtr.Zero, "PerliPreviewHost", null); if (h != IntPtr.Zero) { found = h; return false; } } return true; }, IntPtr.Zero);
    return found;
  }
  public static List<IntPtr> Inside(IntPtr w) { var all = new List<IntPtr>(); EnumChildWindows(w, (c, p) => { all.Add(c); return true; }, IntPtr.Zero); return all; }
}
"@
$h = [Host]::Find($Owner)
if ($h -eq [IntPtr]::Zero) { '{"found":false}'; exit }
$inside = [Host]::Inside($h)
if ($Do -eq "escape") { foreach ($c in $inside) { [void][Host]::PostMessage($c, 0x100, [IntPtr]0x1B, [IntPtr]0x00010001) }; [void][Host]::PostMessage($h, 0x100, [IntPtr]0x1B, [IntPtr]0x00010001) }
$r = New-Object Host+RECT; [void][Host]::GetWindowRect($h, [ref]$r)
$o = New-Object Host+POINT; [void][Host]::ClientToScreen([Host]::GetParent($h), [ref]$o)
$shown = [Host]::IsWindowVisible($h)
if ($Do -eq "shot" -and $shown -and $r.R -gt $r.L) {
  Add-Type -AssemblyName System.Drawing
  $b = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.L, $r.T, 0, 0, $b.Size); $b.Save($args[0]); $g.Dispose(); $b.Dispose()
}
@{ found = $true; shown = $shown; x = $r.L - $o.X; y = $r.T - $o.Y; width = $r.R - $r.L; height = $r.B - $r.T; inside = $inside.Count } | ConvertTo-Json -Compress
`,
);
/** Windows' host window as Windows sees it: shown or not, and where in Perli's window. */
const host = (action = "look", file) =>
  JSON.parse(execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probeScript, String(app.pid), action, ...(file ? [file] : [])], { encoding: "utf8" }).trim());
/** The box the page keeps for the previewer, in physical pixels. */
const box = () => js(`(() => { const b = Q.preview()?.querySelector('.hosted-preview'); if (!b) return null; const r = b.getBoundingClientRect(), s = devicePixelRatio; return { x: Math.round(r.left * s), y: Math.round(r.top * s), width: Math.round(r.width * s), height: Math.round(r.height * s) }; })()`);
const near = (a, b) => !!a && !!b && ["x", "y", "width", "height"].every((side) => Math.abs(a[side] - b[side]) <= 2);
const ready = () => waitFor(() => js(`!!Q.preview()?.querySelector('.hosted-preview[data-ready]')`), 15000);
const officeView = () => js(`Q.preview()?.querySelector('.office-view') ? 1 : 0`);
const strip = () => js(`Q.preview()?.querySelector('.office-strip')?.textContent ?? null`);
const chips = () => js(`[...(Q.preview()?.querySelectorAll('.office-chip') ?? [])].map((c) => c.textContent.trim())`);
const switchButton = () => js(`Q.preview()?.querySelector('.office-switch')?.textContent ?? null`);
const flip = () => js(`Q.preview().querySelector('.office-switch').click()`);
const readerText = () => js(`Q.preview()?.querySelector('.preview-markdown')?.textContent.trim().slice(0, 80) ?? null`);
const closePreview = async () => {
  await inPreview(" ");
  await waitFor(() => js(`!Q.preview()`), 3000);
  await sleep(400);
};
const placed = async () => {
  const [kept, windows] = [await box(), host()];
  note("box / host", { kept, windows });
  return windows.shown && near(kept, windows);
};

try {
  await start();
  check("window on second monitor", (await js("screenX")) < 0, true);
  await goTo(office);
  check("the folder lists the documents", (await names()).includes("report.docx"), true);

  await part("word-office", async () => {
    check("report.docx previews", await preview("report.docx"), true);
    check("as an Office file", await waitFor(async () => (await officeView()) === 1, 5000), true);
    note("strip", await strip());
    check("the strip names it", /^Word document/.test(await strip()), true);
    check("Word's previewer comes up", await ready(), true);
    check("its window sits on the box", await waitFor(placed, 4000), true);
    check("the previewer drew a window in it", host().inside > 0, true);
    host("shot", fileURLToPath(new URL("o-word-host.png", shots)));
    const picture = await js(`__TAURI_INTERNALS__.invoke('previewer_snapshot').then((b) => { const a = new Uint8Array(b); const seen = new Set(); for (let at = 8; at < a.length; at += 997) seen.add(a[at]); return { bytes: a.length, kinds: seen.size }; }, (e) => ({ error: String(e) }))`);
    note("snapshot", picture);
    check("a snapshot reads from the screen", picture.bytes > 8, true);
    check("and is not one flat colour", picture.kinds > 4, true);
    await shot("o-word-page.png", 300);
  });

  await part("cover", async () => {
    if (!(await js(`!!Q.preview()?.querySelector('.hosted-preview[data-ready]')`))) {
      await preview("report.docx");
      await ready();
    }
    note("before cover", { kept: await box(), windows: host() });
    // A menu of Perli's over the previewer: Windows' window would hide it, so a picture stands in.
    await js(`(() => { const r = Q.preview().querySelector('.hosted-preview').getBoundingClientRect(); const m = document.createElement('div'); m.className = 'menu check-cover'; Object.assign(m.style, { position: 'fixed', left: r.left + 40 + 'px', top: r.top + 40 + 'px', width: '160px', height: '120px', background: 'red', zIndex: 99 }); document.body.append(m); })()`);
    check("under a menu, Windows' window hides", await waitFor(async () => !host().shown, 3000), true);
    check("and its picture shows", await js(`!Q.preview().querySelector('.hosted-still').hidden`), true);
    const fit = await js(`(() => { const c = Q.preview().querySelector('.hosted-still'), b = c.parentElement.getBoundingClientRect(), r = c.getBoundingClientRect(); return { canvas: [c.width, c.height, Math.round(r.width), Math.round(r.height)], box: [Math.round(b.width), Math.round(b.height)], dpr: devicePixelRatio }; })()`);
    note("picture fit", fit);
    note("while covered", { kept: await box(), windows: host() });
    check("the picture fills the box", fit.canvas[2] === fit.box[0] && fit.canvas[3] === fit.box[1], true);
    await shot("o-cover-menu.png", 300);
    await js(`document.querySelector('.check-cover').remove()`);
    check("with the menu gone, it comes back", await waitFor(async () => host().shown, 3000), true);
    check("and the picture goes", await js(`Q.preview().querySelector('.hosted-still').hidden`), true);
    // A tooltip is a popover, in the top layer above the preview.
    await js(`(() => { const r = Q.preview().querySelector('.hosted-preview').getBoundingClientRect(); const t = document.createElement('div'); t.popover = 'manual'; t.className = 'tooltip check-tip'; t.textContent = 'tip'; Object.assign(t.style, { position: 'fixed', inset: 'auto', left: r.left + 10 + 'px', top: r.top + 10 + 'px', margin: 0 }); document.body.append(t); t.showPopover(); })()`);
    check("under a tooltip, it hides too", await waitFor(async () => !host().shown, 3000), true);
    await js(`(() => { const t = document.querySelector('.check-tip'); t.hidePopover(); t.remove(); })()`);
    check("and comes back after", await waitFor(async () => host().shown, 3000), true);
  });

  await part("escape", async () => {
    if (!(await js(`!!Q.preview()?.querySelector('.hosted-preview[data-ready]')`))) {
      await preview("report.docx");
      await ready();
    }
    host("escape");
    const closed = await waitFor(() => js(`!Q.preview()`), 3000);
    note("Esc posted to Windows' window closed the preview", closed);
    if (!closed) await closePreview();
    check("with the preview shut, Windows' window is hidden", await waitFor(async () => !host().shown, 3000), true);
  });

  await part("fast", async () => {
    check("budget.xlsx previews", await preview("budget.xlsx"), true);
    // Through deck, download, locked, to notes.rtf, faster than the previewers come up.
    for (let step = 0; step < 4; step++) {
      await inPreview("ArrowDown");
      await sleep(150);
    }
    check("it ends on the RTF", await waitFor(() => js(`!!Q.preview()?.querySelector('.hosted-preview')`), 4000), true);
    check("whose previewer comes up", await ready(), true);
    check("on the box, not hidden by an older close", await waitFor(placed, 4000), true);
    host("shot", fileURLToPath(new URL("o-rtf-host.png", shots)));
    await sleep(1500);
    check("and it stays up", host().shown, true);
    await inPreview("ArrowDown");
    check("the next document comes up in Word's previewer", await ready(), true);
    check("on the box", await waitFor(placed, 4000), true);
    await closePreview();
    check("closed, nothing of Windows' stays", host().shown, false);
  });

  await part("internet", async () => {
    check("download.docx previews", await preview("download.docx"), true);
    await waitFor(async () => (await officeView()) === 1, 5000);
    check("it says where it came from", (await chips()).includes("From the internet"), true);
    check("Perli's reader shows it first", await waitFor(async () => !!(await readerText()), 5000), true);
    note("reader starts", await readerText());
    check("no previewer runs for it", await js(`!Q.preview().querySelector('.hosted-preview')`), true);
    check("Word's previewer is one click away", await switchButton(), "Preview with Word");
    await shot("o-internet.png");
    // Word's previewer refuses a file from the internet, so the reader comes back and says why.
    await flip();
    const said = () => js(`Q.preview()?.querySelector('.office-note[role=status]')?.textContent ?? ''`);
    check("asked anyway, Word's previewer says no", await waitFor(async () => /from the internet/.test(await said()), 15000), true);
    note("note", await said());
    check("and the reader is back", await waitFor(async () => !!(await readerText()), 5000), true);
    check("with nothing of Windows' showing", await waitFor(async () => !host().shown, 3000), true);
    await shot("o-internet-refused.png");
    await closePreview();
  });

  await part("locked", async () => {
    check("locked.docx previews", await preview("locked.docx"), true);
    check("it asks for the password", await waitFor(() => js(`!!Q.preview()?.querySelector('.archive-password input')`), 5000), true);
    check("and says it is protected", (await chips()).includes("Protected"), true);
    check("no Office switch for a locked file", await switchButton(), null);
    const tryPassword = (word) => js(`(() => { const f = Q.preview().querySelector('.archive-password'); P.type(f.querySelector('input'), ${JSON.stringify(word)}); f.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })); })()`);
    await tryPassword("pear");
    check("a wrong password says so", await waitFor(() => js(`!!Q.preview().querySelector('.archive-password-wrong')`), 8000), true);
    await tryPassword("kiwi");
    check("the right one opens it", await waitFor(async () => !!(await readerText()), 8000), true);
    note("unlocked starts", await readerText());
    await shot("o-locked.png");
    await closePreview();
  });

  await part("sheet", async () => {
    check("budget.xlsx previews", await preview("budget.xlsx"), true);
    await waitFor(async () => (await officeView()) === 1, 5000);
    if (await js(`!!Q.preview().querySelector('.hosted-preview')`)) {
      await ready();
      await flip();
    }
    check("Perli's reader shows the sheet", await waitFor(() => js(`!!Q.preview().querySelector('.office-grid table')`), 5000), true);
    note("tabs", await js(`[...Q.preview().querySelectorAll('.office-tab-button')].map((b) => b.textContent)`));
    const goto = `Q.preview().querySelector('.office-goto')`;
    await js(`(() => { const i = ${goto}; P.type(i, 'C4'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    check("Go to cell lights the cell", await waitFor(() => js(`!!Q.preview().querySelector('td[data-flash]')`), 2000), true);
    await js(`(() => { const i = ${goto}; P.type(i, 'ZZ99999'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    check("a cell not there is marked", await js(`${goto}.hasAttribute('data-missing')`), true);
    await shot("o-sheet.png");
    await closePreview();
  });

  await part("slides", async () => {
    check("deck.pptx previews", await preview("deck.pptx"), true);
    await waitFor(async () => (await officeView()) === 1, 5000);
    if (await js(`!!Q.preview().querySelector('.hosted-preview')`)) {
      check("PowerPoint's previewer comes up", await ready(), true);
      check("on the box", await waitFor(placed, 4000), true);
      host("shot", fileURLToPath(new URL("o-pptx-host.png", shots)));
      await flip();
    }
    check("Perli's reader shows slides", await waitFor(() => js(`!!Q.preview().querySelector('.office-slide')`), 5000), true);
    const current = () => js(`[...Q.preview().querySelectorAll('.office-slide-item')].findIndex((b) => b.getAttribute('aria-current') === 'true')`);
    note("slides", await js(`Q.preview().querySelectorAll('.office-slide-item').length`));
    await inPreview("ArrowRight");
    check("the arrow goes to the next slide", await waitFor(async () => (await current()) === 1, 2000), true);
    await inPreview("End");
    note("count", await js(`Q.preview().querySelector('.office-slide-count')?.textContent ?? null`));
    await inPreview("n");
    note("notes shown", await js(`!!Q.preview().querySelector('.office-slide-notes')`));
    await shot("o-slides.png");
    await closePreview();
  });

  await part("broken", async () => {
    check("broken.docx previews", await preview("broken.docx"), true);
    await sleep(5000);
    const said = await js(`Q.preview()?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 300) ?? null`);
    note("it says", said);
    check("the preview says something and stays open", !!said, true);
    await shot("o-broken.png");
    await closePreview();
    check("nothing of Windows' stays", host().shown, false);
  });

  await part("compare", async () => {
    await js(`P.click('report.docx')`);
    await js(`P.click('second.docx', { ctrlKey: true })`);
    await sleep(300);
    await pick("Compare two files");
    check("two Word documents compare as text", await waitFor(() => js(`document.querySelectorAll('.diff-row').length > 3`), 8000), true);
    note("compare says", await js(`document.querySelector('dialog[open]')?.querySelector('.settings-note, .compare-facts')?.textContent ?? null`));
    await shot("o-compare.png");
  });
} finally {
  console.log(failed ? `${failed} FAILED` : "all ok");
  await stop().catch(() => undefined);
  await sleep(1500);
  killAll();
  // Office's previewer servers stay running after their last preview, as they do for Explorer,
  // and keep their logs in this run's TEMP. Only ones this run started are ended.
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(WINWORD|EXCEL|POWERPNT)\.EXE$' -and $_.CommandLine -match 'Embedding' -and $_.CreationDate -gt [datetime]'${runStarted.toISOString()}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`]);
  } catch {}
  await sleep(1000);
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  } catch (error) {
    console.log("     left", root, error.code);
  }
}
