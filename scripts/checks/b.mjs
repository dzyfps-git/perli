// PR B: diagrams, HTML mail, a big song, previews through a reload, deep git and compare edits,
// copies in order, and the whole-PC index with its RAM and disk (slow: ONLY= to skip it).
const mb = (n) => Math.round(n / 1048576);
const ps = (command) => execFileSync("powershell", ["-NoProfile", "-Command", command]).toString().trim();
/** This build's process: what it holds in RAM, in MB. */
const memory = () => {
  const found = JSON.parse(ps(`Get-Process perli | Where-Object { $_.Path -eq '${exe.replaceAll("/", "\\")}' } | Select-Object WorkingSet64, PrivateMemorySize64 | ConvertTo-Json -Compress`) || "[]");
  const all = Array.isArray(found) ? found : [found];
  return { workingSet: mb(all.reduce((sum, p) => sum + p.WorkingSet64, 0)), private: mb(all.reduce((sum, p) => sum + p.PrivateMemorySize64, 0)) };
};
const listFile = join(data, "com.dzyfps.perli", "index.db");
const dbBytes = () => ["", "-wal", "-shm"].reduce((sum, end) => sum + (existsSync(listFile + end) ? statSync(listFile + end).size : 0), 0);
const saveClipboard = () => {
  try {
    return ps(`[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw)))`);
  } catch {
    return "";
  }
};
const restoreClipboard = (saved) => saved && ps(`Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${saved}')))`);

try {
  await start();
  check("window on second monitor", (await js("screenX")) < 0, true);
  await goTo(home);

  await part("mermaid", async () => {
    await preview("diagram.mmd");
    const drew = await waitFor(() => js(`!!Q.preview().querySelector('.md-diagram svg')`), 10000);
    if (!drew) note("preview holds", await js(`Q.preview()?.querySelector('.preview-body, .preview-content')?.outerHTML.slice(0, 1500) ?? Q.preview()?.innerHTML.slice(0, 1500)`));
    check("a .mmd file draws", drew, true);
    const transform = () => js(`Q.preview().querySelector('.md-diagram svg').style.transform`);
    await js(`(() => { const f = Q.preview().querySelector('.md-diagram'); const b = f.getBoundingClientRect(); f.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, ctrlKey: true, clientX: b.left + b.width / 2 + 60, clientY: b.top + b.height / 2, bubbles: true, cancelable: true })); })()`);
    const zoomed = await transform();
    note("zoomed", zoomed);
    check("Ctrl+wheel zooms toward the pointer", /translate\(-?[1-9].*scale\(2\.7/.test(zoomed), true);
    await shot("b-mermaid-zoom.png", 300);
    await js(`Q.button(Q.preview(), 'Fit').click()`);
    check("Fit puts it back", await transform(), "translate(0px, 0px) scale(1)");
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const clipboard = saveClipboard();
    await js(`Q.button(Q.preview(), 'Copy as SVG').click()`);
    check("Copy as SVG", await waitFor(() => js(`Q.button(Q.preview(), 'Copy as SVG').hasAttribute('data-done')`), 3000), true);
    note("copied", ps(`(Get-Clipboard -Raw).Substring(0, 40)`));
    await js(`Q.button(Q.preview(), 'Copy as picture').click()`);
    check("Copy as picture", await waitFor(() => js(`Q.button(Q.preview(), 'Copy as picture').hasAttribute('data-done')`), 4000), true);
    note("picture on the clipboard", ps(`Add-Type -AssemblyName System.Windows.Forms; $i = [Windows.Forms.Clipboard]::GetImage(); if ($i) { "$($i.Width)x$($i.Height)" } else { 'none' }`));
    restoreClipboard(clipboard);
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    await js(`Q.preview().close()`);
    await sleep(400);
    await preview("notes.md");
    check("a mermaid block in Markdown draws", await waitFor(() => js(`!!Q.preview().querySelector('.md-diagram svg')`), 10000), true);
    check("a bad one says what went wrong", await waitFor(() => js(`!!Q.preview().querySelector('.md-diagram-error')`), 6000), true);
    note("error", await js(`Q.preview().querySelector('.md-diagram-error')?.textContent`));
    note("marked line", await js(`Q.preview().querySelector('pre mark')?.textContent ?? null`));
    await shot("b-mermaid-md.png", 300);
    await js(`Q.preview().close()`);
  });

  await part("mail", async () => {
    await preview("html.eml");
    check("an HTML mail shows as laid out", await waitFor(() => js(`!!Q.preview().querySelector('iframe.mail-html')`), 5000), true);
    check("with nothing in it allowed to run", await js(`Q.preview().querySelector('iframe.mail-html').getAttribute('sandbox')`), "");
    await shot("b-mail-html.png", 800);
    await js(`Q.preview().querySelector('.mail-as-text').click()`);
    check("Just the words shows the text", await waitFor(() => js(`!!Q.preview().querySelector('.mail-body')?.textContent.includes('Plain words here')`), 3000), true);
    note("words", await js(`Q.preview().querySelector('.mail-body')?.textContent`));
    check("and the chip offers the way back", await js(`Q.preview().querySelector('.mail-as-text').textContent.trim()`), "As it was laid out");
    await js(`Q.preview().close()`);
    await sleep(400);
    await preview("pieces.eml");
    const named = () => js(`[...Q.preview().querySelectorAll('.mail-attachment-name')].map((n) => n.textContent)`);
    check("an attachment name sent in pieces comes whole", await waitFor(async () => (await named()).join() === "résumé long.txt", 5000), true);
    note("named", await named());
    await js(`Q.preview().close()`);
  });

  await part("midi", async () => {
    const began = Date.now();
    await preview("song.mid");
    check("a song of 120,000 notes opens", await waitFor(() => js(`!!Q.preview().querySelector('.player-lane') && !Q.preview().querySelector('.player-loading')`), 20000), true);
    note("ready after ms", Date.now() - began);
    note("lines", await js(`[...Q.preview().querySelectorAll('.player-title, .player-sub')].map((e) => e.textContent)`));
    await shot("b-midi.png", 500);
    await js(`Q.preview().close()`);
  });

  await part("reload", async () => {
    const texts = join(home, "texts");
    await goTo(texts);
    await preview("long.txt");
    await waitFor(() => js(`Q.preview().textContent.includes('line 20')`), 5000);
    const scroller = `[...Q.preview().querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY))`;
    await js(`(() => { const s = ${scroller}; s.scrollTop = 4000; s.dispatchEvent(new Event('scroll')); s.__kept = true; })()`);
    await sleep(500);
    const top = await js(`${scroller}.scrollTop`);
    note("scrolled to", top);
    writeFileSync(join(texts, "other.txt"), "second\n");
    writeFileSync(join(texts, "added.txt"), "new\n");
    check("the folder reloads", await waitFor(async () => (await names()).includes("added.txt"), 6000), true);
    await sleep(1000);
    check("the preview stays open", await js(`!!Q.preview()`), true);
    check("as the same view, scrolled where it was", await js(`(() => { const s = ${scroller}; return [!!s?.__kept, Math.abs((s?.scrollTop ?? 0) - ${top}) < 5]; })()`), [true, true]);
    await js(`Q.preview().close()`);
  });

  await part("git", async () => {
    const repo = join(home, "repo");
    await goTo(repo);
    await sleep(2000);
    note("marks", await js(`Q.git()`));
    check("a clean repository has no marks", Object.values(await js(`Q.git()`)).every((m) => m === null), true);
    writeFileSync(join(repo, "sub", "inner", "deep.txt"), "deep, changed\n");
    const began = Date.now();
    check("an edit two folders down marks the folder with no F5", await waitFor(async () => !!(await js(`Q.git()`)).sub, 15000), true);
    note("took ms", Date.now() - began);
    note("marks", await js(`Q.git()`));
  });

  await part("compare", async () => {
    await pick("New tab");
    await goTo(join(home, "cmp", "left"));
    await pick("Split view");
    await waitFor(() => js(`Q.panes().length === 2`), 3000);
    await js(`P.mouse(Q.panes()[1], 'pointerdown')`);
    await goTo(join(home, "cmp", "right"));
    await pick("Compare folders");
    const left = `Q.panes()[0]`;
    await waitFor(async () => (await js(`Q.counts(${left})`)).length > 0 && !(await js(`!!${left}.querySelector('.compare-pending')`)), 8000);
    note("marks", await js(`Q.marks(${left})`));
    check("the twin trees match", (await js(`Q.marks(${left})`)).deep, "same");
    writeFileSync(join(home, "cmp", "right", "deep", "sub", "f.txt"), "changed deep inside\n");
    const began = Date.now();
    check("an edit deep inside shows with no F5", await waitFor(async () => (await js(`Q.marks(${left})`)).deep !== "same", 15000), true);
    note("deep now", (await js(`Q.marks(${left})`)).deep);
    note("took ms", Date.now() - began);
    await shot("b-compare.png", 300);
    await pick("Stop comparing folders");
    await wkey("1", { ctrlKey: true, code: "Digit1" });
    await sleep(600);
  });

  await part("copies", async () => {
    const dir = join(home, "copies");
    await goTo(dir);
    await pick("Find copies");
    await waitFor(async () => (await names()).length === 4, 8000);
    const first = await names();
    note("first", first);
    writeFileSync(join(dir, "a0.bin"), Buffer.alloc(10_000, "A"));
    writeFileSync(join(dir, "c1.bin"), Buffer.alloc(300_000, "C"));
    writeFileSync(join(dir, "c2.bin"), Buffer.alloc(300_000, "C"));
    if (!(await waitFor(async () => (await names()).length === 7, 4000))) {
      note("no look again by itself", "F5");
      await key("F5");
    }
    check("the look is done again", await waitFor(async () => (await names()).length === 7, 8000), true);
    const again = await names();
    note("again", again);
    const sets = [...new Set(first.map((n) => n[0]))];
    const kept = sets.flatMap((set) => [...first.filter((n) => n[0] === set), ...again.filter((n) => n[0] === set && !first.includes(n))]);
    check("old sets and rows keep their places, new ones go after", again.slice(0, 5), kept);
    check("and the new set comes last", again.slice(5).sort(), ["c1.bin", "c2.bin"]);
    await shot("b-copies.png", 300);
    await pick("Find copies");
  });

  await part("index", async () => {
    const searchAll = async (text) => {
      await js(`P.type(Q.active().querySelector('.search-input'), ${JSON.stringify(text)})`);
      await waitFor(() => js(`!!Q.active().querySelector('[aria-label="Search every drive"]')`), 3000);
      await js(`Q.active().querySelector('[aria-label="Search every drive"]').click()`);
      return Date.now();
    };
    const clear = () => js(`P.type(Q.active().querySelector('.search-input'), '')`);
    const target = `${probe}.txt`;
    await goTo("D:\\");
    await pick("Show hidden files");
    let began = await searchAll(probe);
    const walked = await waitFor(async () => (await names()).includes(target), 10000);
    note("with no index, a search of every drive found it within 10 s", [walked, Date.now() - began]);
    await clear();
    await sleep(1500);

    const before = memory();
    note("RAM before, MB", before);
    const settings = `document.querySelector('section.settings-page')`;
    await js(`document.querySelector('button[aria-label^="Settings"]').click()`);
    await waitFor(() => js(`!${settings}.hidden`), 3000);
    const section = `${settings}.querySelector('[data-section="index"]')`;
    await js(`${section}.scrollIntoView()`);
    await js(`[...${section}.querySelectorAll('.switch-row')].find((b) => b.textContent.includes('Index every file')).click()`);
    const status = () => invoke("index_status");
    check("the index starts", await waitFor(async () => ["walking", "ready"].includes((await status()).state), 30000), true);
    await shot("b-index-walking.png", 2500);
    await js(`Q.button(${section}, 'Pause').click()`);
    check("Pause stops it", await waitFor(async () => (await status()).state === "paused", 10000), true);
    note("says", await js(`${section}.querySelector('.settings-cache-size').textContent`));
    await js(`Q.button(${section}, 'Go on').click()`);
    check("Go on carries on", await waitFor(async () => (await status()).state !== "paused", 10000), true);

    began = Date.now();
    let peak = before;
    let told = 0;
    let now = await status();
    while (Date.now() - began < 45 * 60_000) {
      now = await status();
      const ram = memory();
      if (ram.workingSet > peak.workingSet) peak = ram;
      if (Date.now() - told > 60_000) {
        note("walking", { minutes: Math.round((Date.now() - began) / 6000) / 10, state: now.state, listed: now.listed, files: now.files, drives: now.drives, ram, listMB: mb(dbBytes()) });
        told = Date.now();
      }
      if (now.state === "ready") break;
      await sleep(5000);
    }
    check("the list gets ready", now.state, "ready");
    note("took minutes", Math.round((Date.now() - began) / 6000) / 10);
    await sleep(20_000);
    const after = memory();
    note("RAM MB: before, peak while walking, ready", [before, peak, after]);
    note("on disk MB", { list: mb(dbBytes()), said: mb(now.bytes), files: now.files, folders: now.folders });
    await shot("b-index-ready.png", 300);

    await wkey("1", { ctrlKey: true, code: "Digit1" });
    check("back to the folder", await waitFor(() => js(`${settings}.hidden && !!Q.active()`), 3000), true);
    began = await searchAll(probe);
    check("with the index, a search of every drive finds it at once", await waitFor(async () => (await names()).includes(target), 3000), true);
    note("found after ms", Date.now() - began);
    await shot("b-index-search.png", 300);
    await clear();
    const fresh = `${probe}-later.txt`;
    writeFileSync(join(home, "probe", fresh), "later\n");
    await sleep(3000);
    began = await searchAll(probe);
    check("a file made after the walk is found too", await waitFor(async () => (await names()).includes(fresh), 3000), true);
    note("found after ms", Date.now() - began);
    await clear();

    await js(`document.querySelector('button[aria-label^="Settings"]').click()`);
    await waitFor(() => js(`!${settings}.hidden`), 3000);
    await js(`${section}.scrollIntoView()`);
    await js(`Q.button(${section}, 'Leave out a folder…').click()`);
    check("Leave out asks for a folder", await waitFor(() => js(`!!document.querySelector('dialog[open]')`), 3000), true);
    await shot("b-index-leave-out.png", 300);
    await js(`for (const d of document.querySelectorAll('dialog[open]')) d.close()`);
    await sleep(400);
    await js(`Q.button(${section}, 'Rebuild').click()`);
    check("Rebuild walks again", await waitFor(async () => (await status()).state === "walking", 15000), true);
    await js(`[...${section}.querySelectorAll('.switch-row')].find((b) => b.textContent.includes('Index every file')).click()`);
    check("turning it off deletes the list", await waitFor(async () => !existsSync(listFile), 15000), true);
  });
} finally {
  console.log(failed ? `${failed} FAILED` : "all ok");
  await stop().catch(() => undefined);
  await sleep(1500);
  killAll();
  await sleep(1000);
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  } catch (error) {
    console.log("     left", root, error.code);
  }
}
