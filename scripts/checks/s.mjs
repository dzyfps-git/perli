// PR 9A: Space and its four lenses, stepping in and out, hover, find, saving a picture, a copy's
// pulse, Tags, and the home page's small Space. The canvas is read through its pixels and the
// list of parts kept for screen readers.
const spaceRoot = join(home, "space-root");
const sheet = `document.querySelector('dialog.space[open]')`;
const title = () => js(`${sheet}?.querySelector('.space-title h2')?.textContent ?? null`);
const status = () => js(`${sheet}?.querySelector('.space-title .settings-note')?.textContent ?? ''`);
const parts = () => js(`[...${sheet}.querySelectorAll('ul.space-unseen button')].map((b) => b.textContent)`);
const lensNow = () => js(`${sheet}.querySelector('.space-lenses [aria-checked=true]')?.textContent ?? null`);
const lens = async (name) => {
  await js(`Q.button(${sheet}.querySelector('.space-lenses'), ${JSON.stringify(name)}).click()`);
  await sleep(900);
};
const spoken = () => js(`${sheet}.querySelector('p.space-unseen').textContent`);
const footer = () => js(`${sheet}.querySelector(':scope > .settings-note').textContent`);
const empty = () => js(`${sheet}.querySelector('.space-empty')?.textContent ?? null`);
const partClick = (start) => js(`[...${sheet}.querySelectorAll('ul.space-unseen button')].find((b) => b.textContent.startsWith(${JSON.stringify(start)})).click()`);
const spaceKey = (k, init = {}) => js(`${sheet}.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ...${JSON.stringify(init)} }))`);
/** How many pixels are drawn on a canvas, and a hash of them, to tell when the picture changes. */
const painted = (canvas = `${sheet}.querySelector('canvas')`) =>
  js(`(() => { const c = ${canvas}; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, h = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) { n++; h = (h * 31 + d[i - 3] + d[i - 2] * 7 + d[i - 1] * 13 + d[i]) | 0; } return { n, h }; })()`);
const settled = () => waitFor(() => js(`!!${sheet} && !${sheet}.querySelector('.space-stage[data-measuring]')`), 10000);
const openSpace = async () => {
  await goTo(spaceRoot);
  await pick("Space");
  await waitFor(() => js(`!!${sheet}`), 3000);
  await settled();
  await sleep(900);
};

try {
  await start();
  check("window on second monitor", (await js("screenX")) < 0, true);

  await part("open", async () => {
    await openSpace();
    check("Space opens on the folder", await title(), "space-root");
    note("status", await status());
    check("it adds everything up", /in 20 items/.test(await status()), true);
    check("Brain is the first lens", await lensNow(), "Brain");
    check("the stage is drawn", (await painted()).n > 2000, true);
    const all = await parts();
    note("parts", all.slice(0, 8));
    check("the biggest part has a node", all.some((p) => p.startsWith("big, ")), true);
    check("its parts come along", all.some((p) => p.startsWith("inner, ")), true);
    check("the many small things fold into one", all.some((p) => p.startsWith("8 more")), true);
    await shot("s-brain.png", 1500);
  });

  await part("hover", async () => {
    await openSpace();
    const name = await js(`(() => {
      const c = ${sheet}.querySelector('canvas');
      const b = c.getBoundingClientRect();
      for (let y = 0.08; y < 0.95; y += 0.03)
        for (let x = 0.04; x < 0.96; x += 0.02) {
          c.dispatchEvent(new PointerEvent('pointermove', { clientX: b.left + b.width * x, clientY: b.top + b.height * y, bubbles: true, pointerId: 1 }));
          const n = ${sheet}.querySelector('.space-card-name')?.textContent;
          if (n) return [n, [...${sheet}.querySelectorAll('.space-card span')].map((s) => s.textContent)];
        }
      return null;
    })()`);
    note("card", name);
    check("pointing at a part shows its card", !!name, true);
    await shot("s-hover.png", 400);
    await js(`${sheet}.querySelector('canvas').dispatchEvent(new PointerEvent('pointerleave', { bubbles: true, pointerId: 1 }))`);
    check("leaving hides it", await waitFor(() => js(`!${sheet}.querySelector('.space-card')`), 1000), true);
  });

  await part("lenses", async () => {
    await openSpace();
    await lens("Cells");
    check("Cells is picked", await lensNow(), "Cells");
    check("Cells draws the parts", (await parts()).some((p) => p.startsWith("big")), true);
    note("cells footer", await footer());
    await shot("s-cells.png", 600);
    await lens("Layers");
    check("Layers is picked", await lensNow(), "Layers");
    const bricks = await parts();
    note("bricks", bricks);
    check("big has a slice in each of its years", bricks.filter((p) => p === "big").length, 2);
    check("Layers says what a band is", (await footer()).startsWith("Each band is a year"), true);
    await shot("s-layers.png", 600);
    await lens("Tags");
    check("with no tags, Tags says so", await empty(), "Nothing here wears a tag yet.");
    await spaceKey("2");
    check("2 picks Cells", await lensNow(), "Cells");
    await spaceKey("1");
    check("1 goes back to Brain", await lensNow(), "Brain");
  });

  await part("into", async () => {
    await openSpace();
    await partClick("big, ");
    check("a folder's node steps into it", await waitFor(async () => (await title()) === "big", 3000), true);
    await settled();
    check("its own parts show", await waitFor(async () => (await parts()).some((p) => p.startsWith("inner")), 3000), true);
    await shot("s-into.png", 900);
    await spaceKey("Backspace");
    check("Backspace goes back up", await waitFor(async () => (await title()) === "space-root", 3000), true);
    await partClick("notes.txt");
    check("a file closes Space", await waitFor(() => js(`!${sheet}`), 3000), true);
    check("and shows it in its folder", await waitFor(async () => (await js(`Q.here()`)) === "space-root", 3000), true);
  });

  await part("find", async () => {
    await openSpace();
    await spaceKey("/");
    check("/ goes to find", await js(`document.activeElement === ${sheet}.querySelector('.space-find input')`), true);
    await js(`P.type(${sheet}.querySelector('.space-find input'), 'photo')`);
    await sleep(300);
    check("find counts what it lights up", await spoken(), "1 found");
    await shot("s-find.png", 600);
    await js(`${sheet}.querySelector('.space-find input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    check("Escape clears find and keeps Space open", await js(`${sheet}?.querySelector('.space-find input').value`), "");
  });

  await part("picture", async () => {
    await openSpace();
    // What the real Pictures holds before, so a miss of the redirect below takes out only what
    // this part put there, never a picture of the user's own.
    const pictures = (await invoke("list_places")).folders.find((folder) => folder.kind === "pictures")?.path;
    const before = new Set(pictures ? readdirSync(pictures) : []);
    // The picture goes to this run's own folder, not the real Pictures. Tauri's invoke can't be
    // replaced, but its IPC goes through fetch, which can.
    await js(`(() => {
      const real = window.__realFetch ?? window.fetch;
      window.__realFetch = real;
      window.fetch = (url, init) => {
        if (!String(url).includes('save_space_picture')) return real(url, init);
        const raw = init.body;
        const body = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        const skip = 4 + new DataView(body.buffer, body.byteOffset).getUint32(0, true);
        const folder = new TextEncoder().encode(${JSON.stringify(home)});
        const out = new Uint8Array(4 + folder.length + body.length - skip);
        new DataView(out.buffer).setUint32(0, folder.length, true);
        out.set(folder, 4);
        out.set(body.subarray(skip), 4 + folder.length);
        return real(url, { ...init, body: out });
      };
    })()`);
    await js(`Q.button(${sheet}, 'Save picture').click()`);
    check("Save picture says where", await waitFor(async () => (await status()).startsWith("Saved in Pictures"), 4000), true);
    const saved = readdirSync(home).filter((name) => name.startsWith("Space of space-root") && name.endsWith(".png"));
    note("saved", saved);
    check("the picture is saved", saved.length, 1);
    if (saved[0]) check("as a PNG", readFileSync(join(home, saved[0])).subarray(1, 4).toString(), "PNG");
    await js(`window.fetch = window.__realFetch`);
    // Should the redirect ever miss, the picture it made is taken out of the real Pictures again.
    const stray = pictures ? readdirSync(pictures).filter((name) => !before.has(name) && name.startsWith("Space of space-root") && name.endsWith(".png")) : [];
    for (const name of stray) rmSync(join(pictures, name));
    check("nothing lands in the real Pictures", stray, []);
  });

  await part("pulse", async () => {
    await openSpace();
    await lens("Cells");
    await sleep(2500);
    const rest = await painted();
    const snap = () => js(`(() => { const c = ${sheet}.querySelector('canvas'); window.__snap = c.getContext('2d').getImageData(0, 0, c.width, c.height).data.slice(); return 1; })()`);
    /** How many pixel values differ from the last snap. */
    const diff = () => js(`(() => { const c = ${sheet}.querySelector('canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i++) if (d[i] !== __snap[i]) n++; return n; })()`);
    await snap();
    await sleep(2500);
    check("Cells rests when nothing happens", await diff(), 0);
    await invoke("start_job", { task: { kind: "copyPaths", paths: [join(spaceRoot, "copy-src.txt")], folder: join(spaceRoot, "big") }, origin: null });
    check("a copy sends a ripple where it lands", await waitFor(async () => (await painted()).h !== rest.h, 3000), true);
    check("the copy lands", existsSync(join(spaceRoot, "big", "copy-src.txt")), true);
    await sleep(2500);
    // The copy made big a little bigger, so its circles took new sizes: the picture rests anew.
    note("pixel values the copy changed", await diff());
    await snap();
    await sleep(2500);
    check("then the picture rests again", await diff(), 0);
    await lens("Brain");
    await invoke("start_job", { task: { kind: "copyPaths", paths: [join(spaceRoot, "notes.txt")], folder: join(spaceRoot, "photos") }, origin: null });
    await shot("s-pulse.png", 450);
  });

  await part("tags", async () => {
    const tag = await invoke("create_tag", { name: "Trip", color: 2 });
    await invoke("restore_tagged", { files: [[join(spaceRoot, "photos", "beach.jpg"), [tag.id]], [join(spaceRoot, "notes.txt"), [tag.id]]] });
    await openSpace();
    await lens("Tags");
    check("a tag is a star", await waitFor(async () => (await parts()).includes("Trip, 2 files"), 3000), true);
    check("its files are specks", (await parts()).includes("beach.jpg"), true);
    await sleep(1200);
    const before = await painted();
    await partClick("Trip");
    check("a star picks out its files", await waitFor(async () => (await painted()).h !== before.h, 2000), true);
    await shot("s-tags.png", 600);
  });

  await part("home", async () => {
    await pick("Home page");
    check("home has a Space part", await waitFor(() => js(`!!document.querySelector('.space-mini')`), 3000), true);
    check("it draws the drives", await waitFor(async () => (await painted(`document.querySelector('.space-mini canvas')`)).n > 500, 4000), true);
    note("logged drives", await js(`Object.keys(JSON.parse(localStorage.getItem('perli-space-log') ?? '{}'))`));
    check("home keeps a free-space sample a day", await js(`Object.keys(JSON.parse(localStorage.getItem('perli-space-log') ?? '{}')).length > 0`), true);
    await shot("s-home.png", 1200);
    await js(`document.querySelector('.space-mini').click()`);
    check("it opens Space on This PC", await waitFor(async () => (await title()) === "This PC", 3000), true);
    await sleep(1500);
    note("status", await status());
    check("This PC counts its drives", /used on \d+ drives?/.test(await status()), true);
    await shot("s-pc.png", 600);
    await lens("Layers");
    check("Layers asks for a drive first", await empty(), "Open a drive to see its years in layers.");
    await lens("Brain");
  });

  // PR 9B: the Time river, Twins and the Colour wall.
  const river = `document.querySelector('dialog.river[open]')`;
  const riverNote = () => js(`${river}?.querySelector('.space-title .settings-note')?.textContent ?? ''`);
  const journal = () => js(`${river}.querySelector('.river-journal').textContent`);
  const riverKey = (k) => js(`${river}.querySelector('canvas').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
  const twins = `document.querySelector('dialog[aria-label="Twins"][open]')`;
  const twinStatus = () => js(`${twins}?.querySelector('.space-title .settings-note')?.textContent ?? ''`);
  const twinFiles = () => js(`[...${twins}.querySelectorAll('ul.space-unseen button')].map((b) => b.textContent)`);
  const twinMode = (name) => js(`Q.button(${twins}.querySelector('.space-lenses'), ${JSON.stringify(name)}).click()`);
  const cleanText = () => js(`[...${twins}.querySelectorAll('button')].find((b) => b.textContent.startsWith('Clean '))?.textContent ?? null`);

  await part("river", async () => {
    // The home part leaves the home page up.
    if ((await js(`Q.panes().length`)) === 0) await pick("Home page");
    await goTo(join(home, "river-root"));
    await pick("Time river");
    check("the Time river opens", await waitFor(() => js(`!!${river}`), 3000), true);
    check("it counts every file", await waitFor(async () => /^3 files/.test(await riverNote()) && !(await js(`!!${river}.querySelector('[data-measuring]')`)), 8000), true);
    note("status", await riverNote());
    check("the river is drawn", (await painted(`${river}.querySelector('canvas')`)).n > 500, true);
    await shot("s-river.png", 800);
    let found = false;
    for (const [k, times] of [["ArrowRight", 1], ["ArrowLeft", 12], ["ArrowRight", 24]]) {
      for (let n = 0; n < times && !found; n++) {
        await riverKey(k);
        await sleep(150);
        found = /3 files changed here/.test(await journal());
      }
    }
    note("journal", await journal());
    check("a day's journal says what changed", found, true);
    await shot("s-river-day.png", 400);
    await js(`Q.button(${river}, 'Show these files').click()`);
    check("Show these files closes the river", await waitFor(() => js(`!${river}`), 3000), true);
    check("and lists that day's files", await waitFor(async () => JSON.stringify((await names()).sort()) === '["r0.txt","r1.txt","r2.txt"]', 6000), true);
    note("rows", await names());
  });

  await part("twins", async () => {
    await goTo(join(home, "twins-root"));
    await pick("Twins");
    check("Twins opens", await waitFor(() => js(`!!${twins}`), 3000), true);
    await twinMode("Same files");
    check("it finds the copies as one set", await waitFor(async () => /^1 set · /.test(await twinStatus()), 10000), true);
    note("status", await twinStatus());
    const files = await twinFiles();
    note("files", files);
    check("one stays", files.filter((f) => f.endsWith(", stays")).length, 1);
    check("the other two go", files.filter((f) => f.endsWith(", goes")).length, 2);
    check("the file of its own is no twin", files.some((f) => f.startsWith("unique")), false);
    await shot("s-twins.png", 1000);
    await js(`[...${twins}.querySelectorAll('ul.space-unseen button')].find((b) => b.textContent === 'a-copy.dat, goes').click()`);
    check("a click keeps another one instead", await waitFor(async () => (await twinFiles()).includes("a-copy.dat, stays"), 2000), true);
    note("clean", await cleanText());
    check("Clean says what it frees", /^Clean 2 \(/.test((await cleanText()) ?? ""), true);
    await js(`[...${twins}.querySelectorAll('button')].find((b) => b.textContent.startsWith('Clean ')).click()`);
    const gone = () => !existsSync(join(home, "twins-root", "a.dat")) && !existsSync(join(home, "twins-root", "copy1", "a.dat"));
    check("cleaning sends the others to the bin", await waitFor(async () => gone(), 8000), true);
    check("and keeps the one picked", existsSync(join(home, "twins-root", "copy2", "a-copy.dat")), true);
    check("the freed room counts up", await waitFor(() => js(`/freed$/.test(${twins}.querySelector('.twins-freed')?.textContent.trim() ?? '')`), 3000), true);
    check("no twins are left", await waitFor(async () => ((await js(`${twins}.querySelector('.space-empty')?.textContent ?? ''`)) ?? "").startsWith("No twins here"), 3000), true);
    await shot("s-twins-clean.png", 800);
    await js(`Q.button(${twins}, 'Undo').click()`);
    check("Undo brings them back", await waitFor(async () => existsSync(join(home, "twins-root", "a.dat")) && existsSync(join(home, "twins-root", "copy1", "a.dat")), 8000), true);
    check("and the set is found again", await waitFor(async () => /^1 set · /.test(await twinStatus()), 10000), true);
  });

  await part("alike", async () => {
    await goTo(join(home, "twins-photos"));
    await pick("Twins");
    await waitFor(() => js(`!!${twins}`), 3000);
    await twinMode("Look alike");
    check("pictures that look alike are a set", await waitFor(async () => /^1 set · /.test(await twinStatus()), 10000), true);
    const files = await twinFiles();
    note("files", files);
    check("the checkerboard is no twin", files.some((f) => f.startsWith("p3")), false);
    check("the sharper one stays", files.includes("p2.bmp, stays"), true);
    check("the pictures show in their circles", await waitFor(async () => (await painted(`${twins}.querySelector('canvas')`)).n > 2000, 4000), true);
    await shot("s-alike.png", 1200);
    await twinMode("Same files");
  });

  await part("colour", async () => {
    await goTo(join(home, "colour-root"));
    await pick("Colour wall");
    check("the wall is a gallery", await waitFor(() => js(`P.grid().dataset.gallery === '' && P.grid().dataset.wall === ''`), 3000), true);
    check("pictures go by colour, greys first", await waitFor(async () => JSON.stringify(await names()) === '["b-grey.bmp","c-red.bmp","d-green.bmp","a-blue.bmp"]', 8000), true);
    note("order", await names());
    await shot("s-colour.png", 900);
    await pick("List view");
  });

  // PR 9C: moments and quiet touches. What a moment shows only briefly is caught as it appears.
  const latch = () =>
    js(`(() => {
      window.__seen = {};
      const look = () => { for (const s of ['.row-ripple', '.pane-stream', '.place-tide', '.place-bridge', '.compare-threads path']) { const n = document.querySelectorAll(s).length; if (n) __seen[s] = Math.max(__seen[s] ?? 0, n); } };
      window.__latch?.disconnect();
      window.__latch = new MutationObserver(look);
      __latch.observe(document.body, { subtree: true, childList: true, attributes: true });
      return 1;
    })()`);
  const seen = (selector) => js(`window.__seen[${JSON.stringify(selector)}] ?? 0`);
  const into = async (at, path) => {
    await js(`Q.panes()[${at}].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    await sleep(200);
    await goTo(path);
  };
  const split = async () => {
    if (!(await js(`Q.panes().length === 2`))) await pick("Split view");
    return waitFor(() => js(`Q.panes().length === 2`), 3000);
  };

  await part("fingerprint", async () => {
    await goTo(join(home, "fp-root"));
    await pick("Grid view");
    check("a folder of other things shows its fingerprint", await waitFor(() => js(`P.row('docs')?.hasAttribute('data-thumb') ?? false`), 6000), true);
    check("a folder with a picture keeps its stack", await waitFor(() => js(`P.row('pics')?.hasAttribute('data-thumb') ?? false`), 6000), true);
    await shot("s-fingerprint.png", 700);
    await pick("List view");
  });

  await part("age", async () => {
    await goTo(spaceRoot);
    check("rows don't dim unless asked", await js(`P.rows().some((r) => r.hasAttribute('data-fade'))`), false);
    await pick("Settings");
    const flip = () => js(`[...document.querySelectorAll('.switch-row')].find((b) => b.querySelector('.switch-label')?.textContent === 'Dim old files')?.click() ?? 'none'`);
    check("Settings has the switch", await waitFor(() => js(`[...document.querySelectorAll('.switch-row')].some((b) => b.querySelector('.switch-label')?.textContent === 'Dim old files')`), 3000), true);
    const done = () => js(`document.querySelector('section.settings-page:not([hidden]) .settings-done')?.click()`);
    await flip();
    await done();
    await waitFor(() => js(`!!Q.active()`), 3000);
    await sleep(600);
    check("old rows dim", await waitFor(() => js(`P.row('old.bin')?.hasAttribute('data-fade') ?? false`), 3000), true);
    note("old.bin opacity", await js(`getComputedStyle(P.row('old.bin')).opacity`));
    check("and look fainter", Number(await js(`getComputedStyle(P.row('old.bin')).opacity`)) < 0.9, true);
    await shot("s-age.png", 400);
    await pick("Settings");
    await waitFor(() => js(`[...document.querySelectorAll('.switch-row')].some((b) => b.querySelector('.switch-label')?.textContent === 'Dim old files')`), 3000);
    await flip();
    await done();
    note("Storage Sense empties the bin after (days)", await invoke("bin_clean_days"));
  });

  await part("stream", async () => {
    await latch();
    check("two panes", await split(), true);
    await into(0, join(home, "stream-src"));
    await into(1, join(home, "stream-dst"));
    await invoke("start_job", { task: { kind: "copyPaths", paths: [join(home, "stream-src", "batch")], folder: join(home, "stream-dst") }, origin: null });
    check("specks stream across the divider", await waitFor(async () => (await seen(".pane-stream")) > 0, 8000), true);
    await shot("s-stream.png", 100);
    note("pace", await js(`document.querySelector('.pane-stream')?.style.getPropertyValue('--pace') ?? null`));
    note("toward the second pane", await js(`document.querySelector('.pane-stream') ? !document.querySelector('.pane-stream').hasAttribute('data-back') : null`));
    const all = () => existsSync(join(home, "stream-dst", "batch")) && readdirSync(join(home, "stream-dst", "batch")).length === 1500;
    check("the copy ends", await waitFor(async () => all(), 60000), true);
    check("the stream stops with the job", await waitFor(() => js(`!document.querySelector('.pane-stream')`), 5000), true);
    check("the new row lands with a ring", await waitFor(async () => (await seen(".row-ripple")) > 0, 3000), true);
    check("the drive's bar shows the tide", await waitFor(async () => (await seen(".place-tide")) > 0, 6000), true);
  });

  await part("threads", async () => {
    await latch();
    await split();
    await into(0, join(home, "cmp-a"));
    await into(1, join(home, "cmp-b"));
    await pick("Compare folders");
    check("threads run between rows of the same name", await waitFor(async () => (await seen(".compare-threads path")) > 0, 6000), true);
    await shot("s-threads.png", 200);
    check("one for each name on both sides", await seen(".compare-threads path"), 2);
    check("then they fade away", await waitFor(() => js(`!document.querySelector('.compare-threads path')`), 4000), true);
    await pick("Stop comparing folders");
  });

  await part("bridge", async () => {
    await latch();
    const syncSheet = `document.querySelector('dialog.cloud-sheet[open]')`;
    const field = (label, value) =>
      js(`(() => { const i = [...${syncSheet}.querySelectorAll('.rename-field')].find((l) => l.textContent.startsWith(${JSON.stringify(label)})).querySelector('input'); P.type(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await goTo(join(home, "stream-src"));
    await js(`P.menu(Q.active().querySelector('.crumb[aria-current]'))`);
    await waitFor(() => js(`!!P.menuItem('Sync this folder…')`), 2000);
    await js(`P.menuItem('Sync this folder…').click()`);
    await waitFor(() => js(`!!${syncSheet}`), 3000);
    await field("To", join(home, "sync-to"));
    await js(`Q.button(${syncSheet}, 'Look first').click()`);
    check("the look is ready", await waitFor(() => js(`!Q.button(${syncSheet}, 'Run now').disabled`), 10000), true);
    await js(`Q.button(${syncSheet}, 'Run now').click()`);
    check("a running sync shows a bridge", await waitFor(async () => (await seen(".place-bridge")) > 0, 10000), true);
    await shot("s-bridge.png", 100);
    const all = () => existsSync(join(home, "sync-to", "batch")) && readdirSync(join(home, "sync-to", "batch")).length === 1500;
    check("the sync copies", await waitFor(async () => all(), 60000), true);
    check("the bridge goes when it ends", await waitFor(() => js(`!document.querySelector('.place-bridge')`), 5000), true);
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
