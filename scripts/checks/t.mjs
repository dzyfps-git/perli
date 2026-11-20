// Phase 10 (PRs 10A and 10B): Tags at scale, the river with hidden files, Twins across places,
// the tide on home drive cards, fingerprints and diagrams that follow the theme, stacked compare
// threads, the copy stream from deeper folders, sync when something changes, S3 batch deletes,
// and Space answered by the index (slow: it walks every drive, ONLY= to skip it).
const sheet = `document.querySelector('dialog.space[open]')`;
const title = () => js(`${sheet}?.querySelector('.space-title h2')?.textContent ?? null`);
const status = () => js(`${sheet}?.querySelector('.space-title .settings-note')?.textContent ?? ''`);
const parts = () => js(`[...${sheet}.querySelectorAll('ul.space-unseen button')].map((b) => b.textContent)`);
const lens = async (name) => {
  await js(`Q.button(${sheet}.querySelector('.space-lenses'), ${JSON.stringify(name)}).click()`);
  await sleep(900);
};
const footer = () => js(`${sheet}.querySelector(':scope > .settings-note').textContent`);
const empty = () => js(`${sheet}.querySelector('.space-empty')?.textContent ?? null`);
const settled = () => waitFor(() => js(`!!${sheet} && !${sheet}.querySelector('.space-stage[data-measuring]')`), 10000);
const openSpace = async (folder) => {
  await goTo(folder);
  await pick("Space");
  await waitFor(() => js(`!!${sheet}`), 3000);
  await settled();
  await sleep(900);
};
const river = `document.querySelector('dialog.river[open]')`;
const riverNote = () => js(`${river}?.querySelector('.space-title .settings-note')?.textContent ?? ''`);
const twins = `document.querySelector('dialog[aria-label="Twins"][open]')`;
const twinStatus = () => js(`${twins}?.querySelector('.space-title .settings-note')?.textContent ?? ''`);
const twinFiles = () => js(`[...${twins}.querySelectorAll('ul.space-unseen button')].map((b) => b.textContent)`);
const places = () => js(`[...${twins}.querySelectorAll('.twins-place:not(.twins-place-add)')].map((p) => p.textContent.replace(/\\uE711/g, '').trim())`);
const offers = () => js(`[...${twins}.querySelectorAll('.twins-place-add')].map((p) => p.textContent.replace(/\\uE710/g, '').trim())`);
/** What a moment shows only briefly is caught as it appears. */
const latch = (selectors) =>
  js(`(() => {
    window.__seen = {};
    const look = () => { for (const s of ${JSON.stringify(selectors)}) { const n = document.querySelectorAll(s).length; if (n) __seen[s] = Math.max(__seen[s] ?? 0, n); } };
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
const job = (task) => invoke("start_job", { task, origin: null });
/** Sets the theme on the page itself, which the theme watch hears. "System" may already be dark,
 *  so a part goes light first and then dark. */
const setTheme = (theme) => js(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);

try {
  await start();
  check("window on second monitor", (await js("screenX")) < 0, true);

  await part("tags-many", async () => {
    const tag = await invoke("create_tag", { name: "Many", color: 3 });
    const files = Array.from({ length: 1200 }, (_, n) => [join(home, "tags-root", `t${String(n).padStart(4, "0")}.txt`), [tag.id]]);
    await invoke("restore_tagged", { files });
    await openSpace(join(home, "tags-root"));
    await lens("Tags");
    check("the tag counts every file", await waitFor(async () => (await parts()).includes("Many, 1,200 files"), 5000), true);
    // The list kept for screen readers stops at its own cap, so the footer tells: it ends by
    // naming any files left undrawn.
    note("footer", await footer());
    check("all 1,200 are drawn, past the old 600", /not drawn\.$/.test(await footer()), false);
    await shot("t-tags-many.png", 1200);
  });

  await part("river-hidden", async () => {
    const count = async () => {
      await goTo(join(home, "river-hidden"));
      await pick("Time river");
      await waitFor(() => js(`!!${river}`), 3000);
      await waitFor(async () => /files?/.test(await riverNote()) && !(await js(`!!${river}.querySelector('[data-measuring]')`)), 8000);
      const said = await riverNote();
      await js(`${river}.close()`);
      await sleep(400);
      return said;
    };
    const plain = await count();
    note("hidden files off", plain);
    check("with hidden files off, the hidden one stays out", /^2 files/.test(plain), true);
    await pick("Show hidden files");
    const all = await count();
    note("hidden files on", all);
    check("with them on, it counts too", /^3 files/.test(all), true);
    await pick("Show hidden files");
  });

  await part("twins-places", async () => {
    await goTo(join(home, "twins-multi"));
    await js(`P.click('a')`);
    await js(`P.click('b', { ctrlKey: true })`);
    await sleep(300);
    await pick("Twins");
    check("Twins opens", await waitFor(() => js(`!!${twins}`), 3000), true);
    check("it looks in both picked folders", (await places()).sort(), ["a", "b"]);
    check("and finds the file in both as one set", await waitFor(async () => /^1 set · /.test(await twinStatus()), 10000), true);
    check("the title says how many places", await js(`${twins}.querySelector('h2').textContent`), "Twins in 2 places");
    note("offers", await offers());
    check("drives are one click away", (await offers()).some((o) => /\([A-Z]:\)$/.test(o) || /^[A-Z]:\\$/.test(o)), true);
    check("each drive named once", (await offers()).some((o) => /\([A-Z]:\) \(/.test(o)), false);
    await shot("t-twins-places.png", 900);
    await js(`${twins}.querySelector('.twins-place-off[aria-label="Stop looking in b"]').click()`);
    check("taking a place away looks again", await waitFor(async () => ((await js(`${twins}.querySelector('.space-empty')?.textContent ?? ''`)) ?? "").startsWith("No twins here"), 8000), true);
    await js(`${twins}.close()`);
    await sleep(400);

    // A folder inside another is walked once, so a file never looks like a copy of itself.
    check("two panes", await split(), true);
    await into(1, join(home, "twins-multi"));
    await into(0, join(home, "twins-multi", "a"));
    await pick("Twins");
    await waitFor(() => js(`!!${twins}`), 3000);
    check("the other pane's folder is offered first", (await offers())[0], "twins-multi");
    await js(`${twins}.querySelector('.twins-place-add').click()`);
    check("adding the folder above finds the set", await waitFor(async () => /^1 set · /.test(await twinStatus()), 10000), true);
    const files = await twinFiles();
    note("files", files);
    check("with each file once", files.length, 2);
    await js(`${twins}.close()`);
  });

  await part("home-tide", async () => {
    await pick("Home page");
    check("home page", await waitFor(() => js(`!!document.querySelector('.home-drive')`), 4000), true);
    await sleep(1500);
    await latch([".home-bar .tide"]);
    await job({ kind: "copyPaths", paths: [join(home, "tide-src", "big.bin")], folder: join(home, "tide-dst") });
    check("the copy lands", await waitFor(async () => existsSync(join(home, "tide-dst", "big.bin")) && statSync(join(home, "tide-dst", "big.bin")).size === 30_000_000, 30000), true);
    check("the drive's card shows the tide", await waitFor(async () => (await seen(".home-bar .tide")) > 0, 6000), true);
    await shot("t-home-tide.png", 100);
  });

  await part("fingerprint-theme", async () => {
    if ((await js(`Q.panes().length`)) === 0) await pick("Home page");
    await goTo(join(home, "fp-root"));
    await pick("Grid view");
    check("the folder shows its fingerprint", await waitFor(() => js(`P.row('docs')?.hasAttribute('data-thumb') ?? false`), 6000), true);
    const picture = () => js(`P.row('docs')?.querySelector('canvas')?.toDataURL() ?? null`);
    const was = await js(`document.documentElement.dataset.theme`);
    await setTheme("light");
    await sleep(2000);
    await waitFor(() => js(`P.row('docs')?.hasAttribute('data-thumb') ?? false`), 6000);
    const before = await picture();
    await setTheme("dark");
    check("a new theme draws its dots again", await waitFor(async () => (await js(`P.row('docs')?.hasAttribute('data-thumb') ?? false`)) && (await picture()) !== before, 6000), true);
    await shot("t-fingerprint-theme.png", 500);
    await setTheme(was);
    await pick("List view");
  });

  await part("diagram-theme", async () => {
    await goTo(home);
    check("the diagram previews", await preview("diagram.mmd"), true);
    const drawing = () => js(`Q.preview()?.querySelector('.md-diagram svg')?.outerHTML ?? null`);
    check("and draws", await waitFor(async () => !!(await drawing()), 10000), true);
    const was = await js(`document.documentElement.dataset.theme`);
    await setTheme("light");
    await sleep(2500);
    const before = await drawing();
    await setTheme("dark");
    check("a new theme draws it again", await waitFor(async () => !!(await drawing()) && (await drawing()) !== before, 8000), true);
    await shot("t-diagram-theme.png", 500);
    await setTheme(was);
    await inPreview(" ");
    await sleep(400);
  });

  await part("threads-stacked", async () => {
    await latch([".compare-threads path"]);
    await split();
    await into(0, join(home, "cmp-a"));
    await into(1, join(home, "cmp-b"));
    const top = () => js(`Q.panes().map((p) => Math.round(p.getBoundingClientRect().top))`);
    await pick("Stack or unstack panes");
    await sleep(800);
    const tops = await top();
    note("pane tops", tops);
    check("the panes stack", tops[0] !== tops[1], true);
    await pick("Compare folders");
    check("threads fall between the stacked panes", await waitFor(async () => (await seen(".compare-threads path")) > 0, 6000), true);
    await shot("t-threads-stacked.png", 200);
    check("one for each name on both sides", await seen(".compare-threads path"), 2);
    await pick("Stop comparing folders");
    await pick("Stack or unstack panes");
    await sleep(600);
  });

  await part("stream-deep", async () => {
    await latch([".pane-stream"]);
    await split();
    await into(0, join(home, "stream-src"));
    await into(1, join(home, "stream-dst"));
    await job({ kind: "copyPaths", paths: [join(home, "stream-src", "deep", "batch")], folder: join(home, "stream-dst", "sub") });
    check("a copy from deeper into a folder inside the other pane streams", await waitFor(async () => (await seen(".pane-stream")) > 0, 8000), true);
    await shot("t-stream-deep.png", 100);
    const all = () => existsSync(join(home, "stream-dst", "sub", "batch")) && readdirSync(join(home, "stream-dst", "sub", "batch")).length === 1500;
    check("the copy ends", await waitFor(async () => all(), 60000), true);
    check("the stream stops with it", await waitFor(() => js(`!document.querySelector('.pane-stream')`), 5000), true);
  });

  await part("sync-change", async () => {
    const [from, to] = [join(home, "sync-from"), join(home, "sync-to")];
    const saved = await invoke("save_sync_pair", { pair: { id: "", from, to, mirror: false, skip: "", every: 0, changed: true, ran: 0 } });
    note("saved", { changed: saved.changed, every: saved.every });
    check("a pair that syncs when something changes is kept", saved.changed, true);
    const refused = await invoke("save_sync_pair", { pair: { id: "", from: "\\\\Perli Cloud\\Nowhere", to, mirror: false, skip: "", every: 0, changed: true, ran: 0 } }).then(() => "saved", (e) => String(e));
    note("a cloud source", refused);
    check("a cloud source can't sync on change", refused !== "saved", true);
    // The first minute look starts the watch; a change then runs on a later, quiet look.
    await sleep(70_000);
    writeFileSync(join(from, "b.txt"), "made later");
    const began = Date.now();
    const ran = await waitFor(async () => existsSync(join(to, "b.txt")), 240_000);
    note("ran after s", Math.round((Date.now() - began) / 1000));
    check("a change in the source syncs by itself", ran, true);
  });

  const seaweed = async () => {
    if (!(await fetch("http://127.0.0.1:8333/").then(() => true, () => false))) {
      note("skipped", "SeaweedFS isn't running: start it with python scripts/checks/seaweed.py");
      return null;
    }
    const weed = process.env.WEED ?? fileURLToPath(new URL("./seaweed/bin/weed.exe", here));
    const input = ["s3.bucket.delete -name perli-test", "s3.bucket.create -name perli-test", "exit", ""].join("\n");
    execFileSync(weed, ["shell", "-master=127.0.0.1:9333"], { input, stdio: ["pipe", "ignore", "ignore"] });
    return JSON.parse(readFileSync(new URL("./seaweed-run/key.json", here), "utf8"));
  };

  await part("s3-batch", async () => {
    const cred = await seaweed();
    if (!cred) return;
    await invoke("add_s3", { setup: { preset: "minio", endpoint: "http://127.0.0.1:8333", region: "us-east-1", bucket: "perli-test", pathStyle: true, keyId: cred.keyId }, secret: cred.secret, name: "Seaweed" });
    const cloud = "\\\\Perli Cloud\\Seaweed";
    const shown = async (folder) => {
      await goTo(folder);
      return names();
    };
    await job({ kind: "copyPaths", paths: [join(home, "many")], folder: cloud });
    check("a folder of 30 files goes up", await waitFor(async () => (await shown(`${cloud}\\many`)).length === 30, 30000), true);
    await goTo(cloud);
    await js(`P.click('many')`);
    await key("Delete");
    const asked = await waitFor(() => js(`Q.confirm()?.textContent.includes('Delete for good?')`), 3000);
    check("deleting it asks first", asked, true);
    if (asked) await js(`Q.button(Q.confirm(), 'Delete').click()`);
    const began = Date.now();
    check("and its 30 keys go in one batch", await waitFor(async () => !(await shown(cloud)).includes("many"), 15000), true);
    note("delete took ms", Date.now() - began);

    // An upload over a file, then Undo: with no versioning on the bucket, it says it can't.
    writeFileSync(join(home, "over.txt"), "first");
    await job({ kind: "copyPaths", paths: [join(home, "over.txt")], folder: cloud });
    await waitFor(async () => (await shown(cloud)).includes("over.txt"), 15000);
    writeFileSync(join(home, "over.txt"), "second, longer");
    await job({ kind: "copyPaths", paths: [join(home, "over.txt")], folder: cloud });
    const replace = await waitFor(() => js(`!![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Replace')`), 10000);
    check("an upload over a file asks", replace, true);
    if (replace) await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Replace').click()`);
    await sleep(3000);
    await goTo(cloud);
    await js(`P.grid().focus()`);
    await key("z", { ctrlKey: true, code: "KeyZ" });
    await sleep(4000);
    note("after Undo", { cards: await js(`[...document.querySelectorAll('.job-card')].map((c) => c.textContent.trim()).slice(-2)`), errors: await js(`__errors.slice()`) });
    for (const place of await invoke("cloud_places").catch(() => [])) await invoke("remove_place", { id: place.id }).catch(() => undefined);
    await goTo(home);
  });

  await part("index-space", async () => {
    if ((await js(`Q.panes().length`)) === 0) await pick("Home page");
    const settings = `document.querySelector('section.settings-page')`;
    const section = `${settings}.querySelector('[data-section="index"]')`;
    const openSettings = async () => {
      await js(`document.querySelector('button[aria-label^="Settings"]').click()`);
      await waitFor(() => js(`!${settings}.hidden`), 3000);
      await js(`${section}.scrollIntoView()`);
    };
    const statusNow = () => invoke("index_status");
    check("with the index off, the list can't answer", await invoke("listed_parts", { path: home }), null);
    await openSettings();
    await js(`[...${section}.querySelectorAll('.switch-row')].find((b) => b.textContent.includes('Index every file')).click()`);
    check("the index starts", await waitFor(async () => ["walking", "ready"].includes((await statusNow()).state), 30000), true);
    note("the admin helper's switch shows", await js(`[...${section}.querySelectorAll('.switch-row')].some((b) => b.textContent.includes('Catch up instantly'))`));
    const began = Date.now();
    let now = await statusNow();
    let told = 0;
    while (Date.now() - began < 45 * 60_000) {
      now = await statusNow();
      if (Date.now() - told > 60_000) {
        note("walking", { minutes: Math.round((Date.now() - began) / 6000) / 10, state: now.state, files: now.files, drives: now.drives });
        told = Date.now();
      }
      if (now.state === "ready") break;
      await sleep(5000);
    }
    check("the list gets ready", now.state, "ready");
    note("took minutes", Math.round((Date.now() - began) / 6000) / 10);
    await wkey("1", { ctrlKey: true, code: "Digit1" });
    await waitFor(() => js(`${settings}.hidden && !!Q.active()`), 3000);

    const drive = home.slice(0, 3);
    let asked = Date.now();
    const listed = await invoke("listed_parts", { path: drive });
    note("the drive's parts from the list, ms", Date.now() - asked);
    check("the list answers what fills the drive", Array.isArray(listed) && listed.length > 0, true);
    note("biggest", (listed ?? []).sort((a, b) => b.bytes - a.bytes).slice(0, 4).map((c) => [c.name, Math.round(c.bytes / 1048576)]));
    check("with years for Layers", (listed ?? []).some((c) => c.years?.length > 0), true);

    asked = Date.now();
    await openSpace(join(home, "space-root"));
    note("Space on a folder done, ms", Date.now() - asked);
    note("status", await status());
    check("Space weighs from the list", /in 2 items/.test(await status()), true);
    check("with its biggest part", (await parts()).some((p) => p.startsWith("big, ")), true);
    note("parts", (await parts()).slice(0, 4));
    // The watch keeps the list current, so a file made now is weighed at once too.
    writeFileSync(join(home, "space-root", "later.bin"), Buffer.alloc(2_000_000, 1));
    await js(`${sheet}.close()`);
    await sleep(3000);
    await openSpace(join(home, "space-root"));
    note("after a new file", await status());
    check("a file made after the walk is counted", /in 3 items/.test(await status()), true);
    await js(`${sheet}.close()`);

    await pick("Home page");
    await waitFor(() => js(`!!document.querySelector('.space-mini')`), 3000);
    await sleep(2500);
    await js(`document.querySelector('.space-mini').click()`);
    check("This PC opens", await waitFor(async () => (await title()) === "This PC", 3000), true);
    await sleep(1500);
    const shown = await parts();
    note("This PC parts", shown.slice(0, 10));
    check("drives show what fills them before anything is weighed", shown.length > (await js(`document.querySelectorAll('.home-drive').length`)), true);
    await shot("t-pc-index.png", 900);
    await lens("Layers");
    note("Layers empty says", await empty());
    check("Layers on This PC draws the drives' years", (await parts()).length > 0 && !(await empty()), true);
    await shot("t-pc-layers.png", 900);
    await lens("Brain");
    await js(`${sheet}.close()`);

    await openSettings();
    await js(`[...${section}.querySelectorAll('.switch-row')].find((b) => b.textContent.includes('Index every file')).click()`);
    check("turning it off deletes the list", await waitFor(async () => !existsSync(join(data, "com.dzyfps.perli", "index.db")), 15000), true);
    await wkey("1", { ctrlKey: true, code: "Digit1" });
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
