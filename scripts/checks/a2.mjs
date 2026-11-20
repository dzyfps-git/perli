// PR A2: mail attachments, compared panes, folder git marks, the gallery's shapes and sharp tiles,
// files in columns, Keep plain, PDF links and forms, the long diff, and windows that come back.
try {
  await start();
  check("window on second monitor", (await js("screenX")) < 0, true);
  await goTo(home);

  await part("mail", async () => {
    await preview("mail.eml");
    check("a mail shows", await waitFor(() => js(`!!Q.preview().querySelector('.mail-view')`), 4000), true);
    check("both attachments listed", await js(`[...Q.preview().querySelectorAll('.mail-attachment-name')].map((n) => n.textContent)`), ["hello.txt", "inner.eml"]);
    await js(`Q.preview().querySelector('[aria-label="Save hello.txt"]').click()`);
    check("Save on one attachment puts it beside the mail", await waitFor(async () => existsSync(join(home, "hello.txt")), 6000), true);
    check("whole", existsSync(join(home, "hello.txt")) && readFileSync(join(home, "hello.txt"), "utf8"), "hello from the mail");
    await sleep(1500);
    note("after save", await js(`[Q.preview()?.querySelector('.preview-name')?.textContent, !!Q.preview()?.querySelector('.mail-view'), P.rows().filter((r) => r.getAttribute('aria-selected') === 'true').map(P.rowName), Q.preview()?.querySelector('.mail-subject')?.textContent]`));
    check("the note stays through the folder's reload", await js(`Q.preview().querySelector('.mail-saved')?.textContent`), "Saved beside the mail");
    await waitFor(() => js(`!!Q.preview().querySelector('[aria-label="Open inner.eml"]')`), 3000);
    await js(`Q.preview().querySelector('[aria-label="Open inner.eml"]').click()`);
    check("an attached mail opens over it", await waitFor(async () => (await js(`Q.preview().querySelector('.mail-subject').textContent`)) === "Inner mail", 4000), true);
    check("with a way back", await js(`!!Q.preview().querySelector('.mail-back')?.textContent.includes('Back to Check mail')`), true);
    await shot("a2-mail-inner.png", 300);
    await inPreview("Backspace");
    check("Backspace goes back", await waitFor(async () => (await js(`Q.preview().querySelector('.mail-subject').textContent`)) === "Check mail", 3000), true);
    await js(`Q.preview().close()`);
  });

  await part("compare", async () => {
    await pick("New tab");
    await goTo(join(home, "left"));
    await pick("Split view");
    await waitFor(() => js(`Q.panes().length === 2`), 3000);
    await js(`P.mouse(Q.panes()[1], 'pointerdown')`);
    await goTo(join(home, "right"));
    note("crumbs", await js(`Q.panes().map((p) => Q.crumbs(p).at(-1))`));
    await pick("Compare folders");
    const left = `Q.panes()[0]`;
    check("counts show", await waitFor(async () => (await js(`Q.counts(${left})`)).length > 0 && !(await js(`!!${left}.querySelector('.compare-pending')`)), 8000), true);
    note("left counts", await js(`Q.counts(${left})`));
    note("right counts", await js(`Q.counts(Q.panes()[1])`));
    const marks = await js(`Q.marks(${left})`);
    check("marks by name", [marks["only-left.txt"], marks["newer.txt"], marks["same.txt"], marks["twin.bin"]], ["only", "newer", "same", "same"]);
    check("a folder that differs deep inside is marked", marks["deep"], "differs");
    note("deep count", await js(`getComputedStyle([...Q.rowsOf(${left})].find((r) => P.rowName(r) === 'deep')).getPropertyValue('--compare-count')`));
    await shot("a2-compare.png", 300);

    await js(`Q.bar(${left}, 'By content').click()`);
    check("By content tells the twins apart", await waitFor(async () => (await js(`Q.marks(${left})`))["twin.bin"] === "differs", 6000), true);

    await js(`Q.bar(${left}, 'Hide same').click()`);
    check("Hide same leaves out the same rows", await waitFor(async () => !("same.txt" in (await js(`Q.marks(${left})`))), 4000), true);
    note("left rows now", Object.keys(await js(`Q.marks(${left})`)));
    await js(`Q.bar(${left}, 'Show').click()`);
    await waitFor(async () => "same.txt" in (await js(`Q.marks(${left})`)), 4000);

    await js(`[...${left}.querySelectorAll('.compare-count')].find((b) => b.dataset.compare === 'only').click()`);
    await sleep(600);
    note("only filter rows", Object.keys(await js(`Q.marks(${left})`)));
    await js(`[...${left}.querySelectorAll('.compare-count')].find((b) => b.getAttribute('aria-pressed') === 'true')?.click()`);
    await sleep(600);

    await js(`Q.bar(${left}, 'Scroll together').click()`);
    await sleep(300);
    await js(`(() => { const g = ${left}.querySelector('.file-grid'); g.scrollTop = 1500; g.dispatchEvent(new Event('scroll')); })()`);
    check("the other pane scrolls along", await waitFor(() => js(`Q.panes()[1].querySelector('.file-grid').scrollTop > 500`), 3000), true);
    note("tops", await js(`Q.panes().map((p) => p.querySelector('.file-grid').scrollTop)`));
    await js(`Q.bar(${left}, 'Scroll together').click()`);
    await js(`Q.bar(${left}, 'By content').click()`);
    await pick("Stop comparing folders");
    await wkey("1", { ctrlKey: true, code: "Digit1" });
    await sleep(600);
    note("panes on tab 1", await js(`Q.panes().length`));
  });

  await part("git", async () => {
    const repo = join(home, "repo");
    await goTo(repo);
    await waitFor(async () => !!(await js(`Q.git()`))["new.txt"], 5000);
    const first = await js(`Q.git()`);
    note("marks", first);
    check("an untracked file is marked, a kept one not", [!!first["new.txt"], first["kept.txt"]], [true, null]);
    writeFileSync(join(repo, "kept.txt"), "kept, then changed\n");
    check("a change marks the file", await waitFor(async () => !!(await js(`Q.git()`))["kept.txt"], 6000), true);
    note("marks", await js(`Q.git()`));
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "second"]);
    check("a commit clears the marks with no F5", await waitFor(async () => Object.values(await js(`Q.git()`)).every((m) => m === null), 8000), true);
    note("marks", await js(`Q.git()`));
    await key("F5");
    await sleep(1200);
    check("and F5 keeps them clear", Object.values(await js(`Q.git()`)).every((m) => m === null), true);
  });

  await part("gallery", async () => {
    await goTo(join(home, "gal"));
    await pick("Gallery view");
    const widths = () => js(`Object.fromEntries(P.rows().map((r) => [P.rowName(r), Math.round(r.getBoundingClientRect().width)]))`);
    const shaped = await waitFor(async () => {
      const w = await widths();
      return w["tall.mp4"] > 0 && w["wide.mp4"] / w["tall.mp4"] > 2.5;
    }, 10000);
    note("widths", await widths());
    check("the tall video takes its own shape", shaped, true);
    await shot("a2-gallery.png", 300);
    const edge = () => js(`P.row('big.png')?.querySelector('canvas.file-thumb')?.width ?? 0`);
    note("thumb edge", await edge());
    await js(`(() => { const s = document.querySelector('.tile-size'); s.value = 400; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    check("tiles at 400 swap in a sharper picture", await waitFor(async () => (await edge()) > 256, 10000), true);
    note("thumb edge at 400", await edge());
    await shot("a2-gallery-400.png", 300);
    await js(`(() => { const s = document.querySelector('.tile-size'); s.value = 112; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await pick("List view");
  });

  await part("columns", async () => {
    const cols = join(home, "cols");
    await goTo(join(cols, "sub"));
    await pick("Column view");
    await pick("Files in columns");
    const column = `[...document.querySelectorAll('.folder-column')].find((c) => c.querySelector('.folder-column-head span')?.textContent === 'cols')`;
    check("the column above lists its files after its folders", await waitFor(async () => (await js(`[...${column}.querySelectorAll('.folder-column-name')].map((n) => n.textContent)`)).join() === "sub,f1.txt,f2.txt", 4000), true);
    note("column", await js(`[...(${column})?.querySelectorAll('.folder-column-name') ?? []].map((n) => n.textContent)`));
    await shot("a2-columns.png", 300);
    await js(`(() => { const b = [...${column}.querySelectorAll('.folder-column-file')].find((b) => b.textContent.includes('f2.txt')); b.focus(); b.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })); })()`);
    check("Space previews a file in a column", await waitFor(() => js(`!!Q.preview()`), 4000), true);
    note("preview of", await js(`Q.preview()?.querySelector('.preview-name')?.textContent`));
    note("Space went to", await js(`Q.here()`));
    await js(`Q.preview()?.close()`);
    await sleep(400);
    await goTo(join(cols, "sub"));
    await waitFor(() => js(`!!${column}`), 3000);
    await js(`[...${column}.querySelectorAll('.folder-column-file')].find((b) => b.textContent.includes('f1.txt')).click()`);
    check("a click shows the file among its folder", await waitFor(async () => (await js(`Q.here()`)) === "cols" && (await js(`P.rows().filter((r) => r.getAttribute('aria-selected') === 'true').map(P.rowName)`)).join() === "f1.txt", 4000), true);
    note("crumbs, selected", await js(`[Q.here(), P.rows().filter((r) => r.getAttribute('aria-selected') === 'true').map(P.rowName)]`));
    await pick("Only folders in columns");
    await pick("List view");
  });

  await part("keep plain", async () => {
    const looks = join(home, "looks");
    await goTo(home);
    await menuPick("looks", "Folder look");
    await waitFor(() => js(`!!document.querySelector('dialog.look-picker[open]')`), 3000);
    await js(`document.querySelector('dialog.look-picker[open] .look-color:not(.look-none)').click()`);
    await js(`document.querySelector('dialog.look-picker[open] .look-inside').click()`);
    await sleep(300);
    await js(`Q.button(document.querySelector('dialog.look-picker[open] .confirm-buttons'), 'Done')?.click() ?? document.querySelector('dialog.look-picker[open]').close()`);
    await sleep(400);
    await goTo(looks);
    const looked = () => js(`Object.fromEntries(P.rows().map((r) => [P.rowName(r), r.hasAttribute('data-look')]))`);
    check("the folders inside take the look", await waitFor(async () => (await looked()).child === true, 3000), true);
    await menuPick("child", "Folder look");
    await waitFor(() => js(`!!document.querySelector('dialog.look-picker[open] .look-source')`), 3000);
    note("source", await js(`document.querySelector('dialog.look-picker[open] .look-source')?.textContent`));
    check("the picker says where the look comes from", await js(`document.querySelector('dialog.look-picker[open] .look-source').textContent.startsWith('Takes its look from looks')`), true);
    await shot("a2-look-source.png", 300);
    await js(`Q.button(document.querySelector('dialog.look-picker[open] .look-source'), 'Keep plain').click()`);
    check("Keep plain says so", await waitFor(() => js(`document.querySelector('dialog.look-picker[open] .look-source').textContent.startsWith('Kept plain')`), 2000), true);
    await js(`document.querySelector('dialog.look-picker[open]').close()`);
    await sleep(400);
    note("looks after Keep plain", await looked());
    check("the kept-plain folder drops the look, the other keeps it", await waitFor(async () => {
      const now = await looked();
      return now.child === false && now.other === true;
    }, 3000), true);
    await goTo(join(looks, "child"));
    check("and so do the folders inside it", (await looked()).deep, false);
  });

  await part("pdf", async () => {
    await goTo(home);
    const original = readFileSync(join(home, "form.pdf"));
    await preview("form.pdf");
    check("the form's fields show", await waitFor(() => js(`!!Q.preview().querySelector('.annotationLayer input')`), 8000), true);
    note("layer", await js(`(() => { const l = Q.preview().querySelector('.annotationLayer'); const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }; const sec = [...l.querySelectorAll('section')]; return { layer: l.style.cssText, layerBox: r(l), page: r(l.parentElement), pageVars: l.parentElement.style.cssText, sections: sec.map((x) => [x.className, x.style.cssText, r(x)]), computed: [getComputedStyle(l).position, getComputedStyle(l).width] }; })()`));
    check("the fields sit on the page where the PDF puts them", await js(`(() => { const page = Q.preview().querySelector('.pdf-page').getBoundingClientRect(); const field = Q.preview().querySelector('.annotationLayer .textWidgetAnnotation').getBoundingClientRect(); const at = (field.left - page.left) / page.width; return field.width > page.width * 0.4 && at > 0.18 && at < 0.21; })()`), true);
    const pageNow = () => js(`Q.preview().querySelector('[aria-label="Go to page"]').value`);
    note("links", await js(`[...Q.preview().querySelectorAll('.annotationLayer a')].map((a) => [a.getAttribute('href'), a.dataset.tip ?? null])`));
    check("every link says where it leads", await js(`[...Q.preview().querySelectorAll('.annotationLayer a')].map((a) => (a.dataset.tip ?? '').split(String.fromCharCode(10)).at(-1)).sort()`), ["Page 2", "https://example.com/"]);
    await js(`[...Q.preview().querySelectorAll('.annotationLayer a')].find((a) => a.dataset.tip?.endsWith('Page 2')).click()`);
    check("a link into the PDF goes there", await waitFor(async () => (await pageNow()) === "2", 4000), true);
    check("with a Back", await waitFor(() => js(`Q.preview().querySelector('.pdf-resume')?.textContent.trim() === 'Back to page 1'`), 2000), true);
    await shot("a2-pdf-back.png", 300);
    await inPreview("ArrowLeft", { altKey: true });
    check("Alt+Left comes back", await waitFor(async () => (await pageNow()) === "1", 4000), true);
    await js(`[...Q.preview().querySelectorAll('.annotationLayer a')].find((a) => a.dataset.tip?.startsWith('https')).click()`);
    check("a web link asks first", await waitFor(() => js(`!!Q.confirm()`), 3000), true);
    note("asks", await js(`Q.confirm()?.textContent.replace(/\\s+/g, ' ').trim()`));
    await shot("a2-pdf-link.png", 300);
    await js(`Q.button(Q.confirm(), 'Cancel').click()`);
    await sleep(400);

    await js(`P.type(Q.preview().querySelector('.annotationLayer input[type="text"], .annotationLayer .textWidgetAnnotation input'), 'Sam Check')`);
    check("filling a field offers to save", await waitFor(() => js(`!!Q.preview().querySelector('.pdf-save')`), 3000), true);
    await shot("a2-pdf-filled.png", 300);
    await js(`Q.preview().querySelector('.pdf-save').click()`);
    const copy = join(home, "form (filled).pdf");
    check("Save a filled copy lands beside it", await waitFor(async () => existsSync(copy), 6000), true);
    await sleep(1500);
    check("and the view keeps the filled field", await js(`Q.preview().querySelector('.annotationLayer input[type="text"], .annotationLayer .textWidgetAnnotation input')?.value`), "Sam Check");
    check("holding the filled field", existsSync(copy) && readFileSync(copy, "latin1").includes("Sam Check"), true);
    check("and leaves the original as it was", readFileSync(join(home, "form.pdf")).equals(original), true);
    note("told", await js(`Q.preview().querySelector('.pdf-told')?.textContent`));

    check("a saved copy leaves nothing to save", await js(`!!Q.preview().querySelector('.pdf-save')`), false);
    await js(`P.type(Q.preview().querySelector('.annotationLayer input[type="text"], .annotationLayer .textWidgetAnnotation input'), 'Sam Over')`);
    await waitFor(() => js(`!!Q.button(Q.preview(), 'Save over the original')`), 3000);
    await js(`Q.button(Q.preview(), 'Save over the original').click()`);
    check("Save over the original fills the file", await waitFor(async () => readFileSync(join(home, "form.pdf"), "latin1").includes("Sam Over"), 8000), true);
    await shot("a2-pdf-over.png", 600);
    await js(`Q.preview().close()`);
    await sleep(500);
    await js(`P.click('a.txt')`);
    await key("z", { ctrlKey: true, code: "KeyZ" });
    check("Undo puts the original back", await waitFor(async () => readFileSync(join(home, "form.pdf")).equals(original), 8000), true);
  });

  await part("diff", async () => {
    await goTo(home);
    await js(`P.click('big-a.txt')`);
    await js(`P.click('big-b.txt', { ctrlKey: true })`);
    await menuPick("big-b.txt", "Compare");
    check("the long compare finishes", await waitFor(() => js(`!!document.querySelector('dialog.compare[open] .diff-summary')`), 15000), true);
    const chips = await js(`[...document.querySelectorAll('dialog.compare[open] .diff-summary .compare-chip')].map((c) => c.textContent)`);
    note("summary", await js(`document.querySelector('dialog.compare[open] .diff-summary')?.textContent`));
    check("only the changed lines are marked", chips.slice(0, 2), ["+5,000", "−5,000"]);
    check("it shows rows", await js(`document.querySelectorAll('dialog.compare[open] .diff-line').length > 10`), true);
    await shot("a2-diff.png", 300);
  });

  await part("windows", async () => {
    const [a, b] = [join(home, "cols"), join(home, "looks")];
    await goTo(a);
    const moved = JSON.stringify({ tab: { panes: [{ path: b }], active: 0 }, place: { ...SPOT, x: SPOT.x + 80, y: SPOT.y + 60 } });
    await invoke("open_window", { folder: b, select: [], moved });
    check("a second window opens", await waitFor(async () => (await pages()).length === 2, 10000), true);
    await sleep(3000);

    // Killed, as a Windows restart would: both come back.
    killAll();
    await exited;
    page.close();
    await sleep(1000);
    await start();
    check("both windows come back after a kill", await waitFor(async () => (await pages()).length === 2, 10000), true);
    await sleep(1500);
    // Each window is a process of its own, so they go by the folder each shows.
    let all = await every();
    const shows = async () => (await Promise.all(all.map((one) => one.js(`Q.here()`)))).sort();
    check("each in its own folder", await shows(), ["cols", "looks"]);
    const by = async (folder) => {
      for (const one of all) if ((await one.js(`Q.here()`)) === folder) return one;
    };
    page.close();
    page = await by("cols");
    const other = await by("looks");
    note("other at", await other.js(`[screenX, screenY]`));
    check("the other window back on its spot", (await other.js(`screenX`)) < 0, true);

    // Closed while the main one stays: Reopen closed window brings it back.
    await other.js(`document.querySelector('.window-close').click()`);
    check("closing one leaves the other", await waitFor(async () => (await pages()).length === 1, 6000), true);
    for (const one of all) if (one !== page) one.close();
    await pick("Reopen closed window");
    check("Reopen closed window brings it back", await waitFor(async () => (await pages()).length === 2, 8000), true);
    await sleep(1500);
    all = await every();
    check("in its folder", await shows(), ["cols", "looks"]);
    page = await by("cols");

    // Workspaces: next and previous with a pill, then one brought from the other window.
    await wkey("w", { ctrlKey: true, altKey: true, code: "KeyW" });
    await sleep(400);
    await js(`P.type(document.querySelector('.palette-input'), 'One')`);
    await sleep(400);
    await js(`[...document.querySelectorAll('.palette-option')].find((o) => o.textContent.includes('Save tabs as workspace')).click()`);
    await sleep(600);
    await wkey("w", { ctrlKey: true, altKey: true, code: "KeyW" });
    await sleep(400);
    await js(`P.type(document.querySelector('.palette-input'), 'Two')`);
    await sleep(400);
    await js(`[...document.querySelectorAll('.palette-option')].find((o) => o.querySelector('.palette-name')?.textContent.startsWith('New workspace')).click()`);
    await sleep(1200);
    check("a new workspace starts afresh", await waitFor(async () => (await js(`Q.panes().length ? Q.here() : 'Home page'`)) !== "cols", 3000), true);
    note("Two shows", await js(`Q.panes().length ? Q.here() : document.title`));
    await wkey("PageDown", { ctrlKey: true, altKey: true, code: "PageDown" });
    check("Ctrl+Alt+PageDown shows the pill", await waitFor(() => js(`!!document.querySelector('.workspace-pill')`), 2000), true);
    note("pill", await js(`document.querySelector('.workspace-pill')?.textContent`));
    await shot("a2-pill.png", 100);
    check("and goes to the next workspace", await waitFor(async () => (await js(`Q.here()`)) === "cols", 3000), true);

    const second = await by("looks");
    await second.js(`P.wkey('w', { ctrlKey: true, altKey: true, code: 'KeyW' })`);
    const bring = `[...document.querySelectorAll('.palette-option')].find((o) => o.querySelector('.palette-name')?.textContent === 'Bring "One" here')`;
    check("the other window offers to bring it", await waitFor(() => second.js(`!!${bring}`), 3000), true);
    note("other window's list", await second.js(`[...document.querySelectorAll('.palette-option')].map((o) => o.textContent.trim())`));
    await second.js(`${bring}.click()`);
    check("Bring here closes the window that had it", await waitFor(async () => (await pages()).length === 1, 8000), true);
    page.close();
    all = await every();
    page = all[0];
    check("and the workspace shows here", await waitFor(async () => (await js(`Q.here()`)) === "cols", 4000), true);
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
