// PR C: the Add place sheet, sync, S3 against a local SeaweedFS (python seaweed.py first),
// the cloud Note column, and a PDF whose total adds itself up.
const place = (label) => `[...document.querySelectorAll('.places .place')].find((p) => p.querySelector('.place-label')?.textContent === ${JSON.stringify(label)})`;
const sheet = () => `document.querySelector('dialog.cloud-sheet[open]')`;
const hint = () => js(`${sheet()}?.querySelector('.drive-hint')?.textContent.trim()`);
const reload = async () => {
  await js(`location.reload()`).catch(() => undefined);
  await sleep(3000);
  const all = await every();
  page = all.find((one) => one.label === "main") ?? all[0];
};

try {
  await start();
  check("window on second monitor", (await js("screenX")) < 0, true);
  await goTo(home);

  await part("cloud-sheet", async () => {
    check("the sidebar offers a cloud place", await js(`!!${place("Add a cloud place")}`), true);
    await js(`${place("Add a cloud place")}.click()`);
    check("the sheet opens", await waitFor(() => js(`!!${sheet()}`), 3000), true);
    check("with four kinds", await js(`[...${sheet()}.querySelectorAll('.cloud-kind-name')].map((n) => n.textContent)`), ["OneDrive", "Dropbox", "Google Drive", "S3 storage"]);
    await shot("c-add-place.png", 400);
    await js(`[...${sheet()}.querySelectorAll('.cloud-kind')].find((b) => b.textContent.includes('OneDrive')).click()`);
    const told = await waitFor(async () => /registered/.test((await hint()) ?? ""), 4000);
    note("OneDrive says", await hint());
    check("a service with no app id says so, asking nothing of the web", told, true);
    await js(`[...${sheet()}.querySelectorAll('.cloud-kind')].find((b) => b.textContent.includes('S3')).click()`);
    await sleep(300);
    check("S3 asks for its bucket and key", await js(`${sheet()}.querySelectorAll('input').length`), 5);
    check("the S3 form says what it needs, not the last failure", /bucket|key/.test((await hint()) ?? ""), true);
    note("S3 hint", await hint());
    await js(`(() => { const s = ${sheet()}.querySelector('select'); s.value = 'r2'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(200);
    check("R2 asks for its account", await js(`[...${sheet()}.querySelectorAll('.rename-field')].some((l) => l.textContent.startsWith('Account ID'))`), true);
    await shot("c-s3-form.png", 300);
    await js(`Q.button(${sheet()}, 'Cancel').click()`);
    check("Cancel closes it", await waitFor(() => js(`!${sheet()}`), 2000), true);
    await goTo("\\\\Perli Cloud");
    check("the list of places opens", await js(`Q.crumbs()`), ["Cloud"]);
    note("error", await js(`Q.active().querySelector('.message')?.textContent ?? null`));
    check("with no places, it is empty and fine", await js(`!Q.active().querySelector('.message')`), true);
    await goTo(home);
  });

  await part("sync", async () => {
    const [from, to] = [join(home, "sync-from"), join(home, "sync-to")];
    const field = (label, value) =>
      js(`(() => { const i = [...${sheet()}.querySelectorAll('.rename-field')].find((l) => l.textContent.startsWith(${JSON.stringify(label)})).querySelector('input'); P.type(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await goTo(from);
    await js(`P.menu(Q.active().querySelector('.crumb[aria-current]'))`);
    await waitFor(() => js(`!!P.menuItem('Sync this folder…')`), 2000);
    await js(`P.menuItem('Sync this folder…').click()`);
    check("a folder's menu starts a sync from it", await waitFor(() => js(`${sheet()}?.querySelector('input')?.value === ${JSON.stringify(from)}`), 3000), true);
    await field("To", to);
    await field("Leave out", "*.tmp");
    check("a first run waits for a look", await js(`Q.button(${sheet()}, 'Run now').disabled`), true);
    await js(`Q.button(${sheet()}, 'Look first').click()`);
    check("the look counts what goes", await waitFor(async () => /2 to copy.*1 to the bin first/.test((await hint()) ?? ""), 5000), true);
    note("look", await hint());
    await shot("c-sync-look.png", 300);
    await js(`Q.button(${sheet()}, 'Run now').click()`);
    const copied = await waitFor(async () => existsSync(join(to, "a.txt")) && readFileSync(join(to, "sub", "b.txt"), "utf8") === "the newer, longer b", 10000);
    check("Update copies what is new and changed", copied, true);
    check("leaves out what it should", existsSync(join(to, "skip.tmp")), false);
    check("and takes nothing away", existsSync(join(to, "old.txt")), true);
    check("the pair shows in the sidebar", await waitFor(() => js(`!!${place("sync-from → sync-to")}`), 4000), true);
    await sleep(1000);
    await js(`P.grid().focus()`);
    await key("z", { ctrlKey: true, code: "KeyZ" });
    let undone = await waitFor(async () => !existsSync(join(to, "a.txt")) && readFileSync(join(to, "sub", "b.txt"), "utf8") === "old b", 6000);
    if (!undone) {
      note("after Ctrl+Z", { a: existsSync(join(to, "a.txt")), b: readFileSync(join(to, "sub", "b.txt"), "utf8"), focus: await js(`document.activeElement?.className ?? null`), cards: await js(`[...document.querySelectorAll('.job-card, .jobs-panel *')].map((c) => c.textContent).slice(0, 4)`) });
      note("undo by invoke", await invoke("undo_job", { origin: null, step: null }).then(() => "sent", (e) => String(e)));
      undone = await waitFor(async () => !existsSync(join(to, "a.txt")) && readFileSync(join(to, "sub", "b.txt"), "utf8") === "old b", 6000);
      note("then", { a: existsSync(join(to, "a.txt")), b: readFileSync(join(to, "sub", "b.txt"), "utf8"), errors: await js(`__errors.slice()`) });
    }
    check("Undo puts the target back as it was", undone, true);

    await js(`P.menu(${place("sync-from → sync-to")})`);
    await waitFor(() => js(`!!P.menuItem('Edit…')`), 2000);
    await js(`P.menuItem('Edit…').click()`);
    await waitFor(() => js(`!!${sheet()}`), 3000);
    await js(`Q.button(${sheet()}, 'Mirror').click()`);
    await sleep(200);
    check("a mirror looks before each run", await js(`Q.button(${sheet()}, 'Run now').disabled`), true);
    await js(`Q.button(${sheet()}, 'Look first').click()`);
    await waitFor(async () => /to the bin first/.test((await hint()) ?? ""), 5000);
    note("mirror look", await hint());
    check("a mirror takes away what went", await js(`[...${sheet()}.querySelectorAll('.sync-lines li')].some((l) => l.textContent.endsWith('old.txt'))`), true);
    await js(`Q.button(${sheet()}, 'Run now').click()`);
    check("and does", await waitFor(async () => !existsSync(join(to, "old.txt")) && existsSync(join(to, "a.txt")), 10000), true);
    note("pairs", (await invoke("sync_pairs")).map((p) => ({ ran: p.ran > 0, mirror: p.mirror, skip: p.skip })));
    await shot("c-sync-sidebar.png", 600);
  });

  /** The s3 and note parts need SeaweedFS, which `python scripts/checks/seaweed.py` starts with a
   *  test key of its own. Each starts on an empty bucket. */
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
  // Each run's places keep their keys in Windows' Credential Manager: take them away again.
  const dropPlaces = async () => {
    for (const place of await invoke("cloud_places").catch(() => [])) await invoke("remove_place", { id: place.id }).catch(() => undefined);
  };

  await part("s3", async () => {
    const cred = await seaweed();
    if (!cred) return;
    const cloud = "\\\\Perli Cloud\\Seaweed";
    const up = join(home, "up");
    const down = join(home, "down");
    mkdirSync(join(up, "folder", "inner"), { recursive: true });
    mkdirSync(down, { recursive: true });
    writeFileSync(join(up, "small.txt"), "hello cloud");
    writeFileSync(join(up, "folder", "inner", "deep.txt"), "deep down");
    const big = Buffer.alloc(40 * 1024 * 1024);
    for (let at = 0; at < big.length; at += 4) big.writeUInt32LE((at * 2654435761) >>> 0, at);
    writeFileSync(join(up, "big.bin"), big);
    const job = (task) => invoke("start_job", { task, origin: null });
    const shown = async (folder) => {
      await goTo(folder);
      return names();
    };
    const field = (label, value) =>
      js(`(() => { const i = [...${sheet()}.querySelectorAll('.rename-field')].find((l) => l.textContent.startsWith(${JSON.stringify(label)})).querySelector('input'); P.type(i, ${JSON.stringify(value)}); })()`);

    await js(`${place("Add a cloud place")}.click()`);
    await waitFor(() => js(`!!${sheet()}`), 3000);
    await js(`[...${sheet()}.querySelectorAll('.cloud-kind')].find((b) => b.textContent.includes('S3')).click()`);
    await sleep(300);
    await js(`(() => { const s = ${sheet()}.querySelector('select'); s.value = 'minio'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(200);
    await field("Address", "http://127.0.0.1:8333");
    await field("Bucket", "perli-test");
    await field("Access key", cred.keyId);
    await field("Secret", cred.secret);
    await field("Name", "Seaweed");
    await js(`Q.button(${sheet()}, 'Add').click()`);
    const added = await waitFor(() => js(`!${sheet()}`), 10000);
    if (!added) note("sheet says", await hint());
    check("an S3 bucket is added after one look at it", added, true);
    check("and opens", await waitFor(async () => JSON.stringify(await js(`Q.crumbs()`)) === JSON.stringify(["Cloud", "Seaweed"]), 5000), true);
    check("it shows in the sidebar", await js(`!!${place("Seaweed")}`), true);
    check("a wrong secret is refused", await invoke("add_s3", { setup: { preset: "minio", endpoint: "http://127.0.0.1:8333", region: "us-east-1", bucket: "perli-test", pathStyle: true, keyId: cred.keyId }, secret: "wrong", name: "Bad" }).then(() => "added", (e) => String(e).slice(0, 80)) !== "added", true);

    let began = Date.now();
    await job({ kind: "copyPaths", paths: [join(up, "small.txt"), join(up, "folder"), join(up, "big.bin")], folder: cloud });
    const uploaded = await waitFor(async () => (await shown(cloud)).length >= 3, 60000);
    note("upload took ms", Date.now() - began);
    check("files, a folder and a 40 MB file in parts go up", (await shown(cloud)).sort(), ["big.bin", "folder", "small.txt"]);
    check("what is inside the folder went too", await shown(`${cloud}\\folder\\inner`), ["deep.txt"]);
    await shot("c-s3-list.png", 300);

    await goTo(cloud);
    check("a cloud file previews", await preview("small.txt"), true);
    check("with what it holds", await waitFor(() => js(`Q.preview()?.textContent.includes('hello cloud')`), 6000), true);
    await inPreview(" ");
    await sleep(400);

    began = Date.now();
    await job({ kind: "copyPaths", paths: [`${cloud}\\small.txt`, `${cloud}\\big.bin`, `${cloud}\\folder`], folder: down });
    const came = await waitFor(async () => existsSync(join(down, "big.bin")) && existsSync(join(down, "folder", "inner", "deep.txt")) && existsSync(join(down, "small.txt")), 60000);
    note("download took ms", Date.now() - began);
    check("they come down", came, true);
    check("the big one whole", came && readFileSync(join(down, "big.bin")).equals(big), true);
    check("the deep one as it was", came && readFileSync(join(down, "folder", "inner", "deep.txt"), "utf8"), "deep down");

    await job({ kind: "new", folder: cloud, directory: true });
    check("a new folder is made", await waitFor(async () => (await shown(cloud)).includes("New folder"), 10000), true);
    await job({ kind: "movePaths", paths: [`${cloud}\\small.txt`], folder: `${cloud}\\New folder` });
    check("a move within the bucket", await waitFor(async () => !(await shown(cloud)).includes("small.txt"), 10000), true);
    check("lands there", await shown(`${cloud}\\New folder`), ["small.txt"]);
    await goTo(cloud);
    await js(`P.grid().focus()`);
    await key("z", { ctrlKey: true, code: "KeyZ" });
    check("Undo moves it back", await waitFor(async () => (await shown(cloud)).includes("small.txt"), 10000), true);

    await js(`P.type(Q.active().querySelector('.search-input'), 'deep')`);
    const found = await waitFor(async () => (await names()).includes("deep.txt"), 8000);
    note("search found", await names());
    check("a search below finds a file deep in the bucket", found, true);
    await js(`P.type(Q.active().querySelector('.search-input'), '')`);
    await sleep(800);

    await job({ kind: "copyPaths", paths: [join(up, "small.txt")], folder: cloud });
    const asked = await waitFor(() => js(`!![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Keep both')`), 10000);
    check("a name there already is asked about", asked, true);
    await shot("c-s3-conflict.png", 300);
    if (asked) await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Keep both').click()`);
    check("Keep both gives a free name", await waitFor(async () => (await shown(cloud)).includes("small (2).txt"), 10000), true);

    await goTo(cloud);
    await js(`P.click('big.bin')`);
    await key("Delete");
    const confirm = await waitFor(() => js(`Q.confirm()?.textContent.includes('Delete for good?')`), 3000);
    check("an S3 delete asks first", confirm, true);
    if (confirm) await js(`Q.button(Q.confirm(), 'Delete').click()`);
    check("and deletes", await waitFor(async () => !(await shown(cloud)).includes("big.bin"), 10000), true);

    await invoke("save_sync_pair", { pair: { id: "", from: join(home, "sync-from"), to: `${cloud}\\New folder`, mirror: false, skip: "*.tmp", every: 0, ran: 0 } });
    const pair = (await invoke("sync_pairs")).find((one) => one.to.endsWith("New folder"));
    await job({ kind: "sync", id: pair.id });
    check("a sync goes up into the bucket", await waitFor(async () => (await shown(`${cloud}\\New folder`)).includes("a.txt"), 15000), true);
    check("with its folders", await shown(`${cloud}\\New folder\\sub`), ["b.txt"]);
    const again = await invoke("sync_preview", { pair });
    note("a second look", { copies: again.copies.length, removes: again.removes.length });
    check("a second run finds nothing to do", again.copies.length + again.removes.length, 0);
    await goTo(home);
  });
  await dropPlaces();

  await part("note", async () => {
    const cred = await seaweed();
    if (!cred) return;
    await invoke("add_s3", { setup: { preset: "minio", endpoint: "http://127.0.0.1:8333", region: "us-east-1", bucket: "perli-test", pathStyle: true, keyId: cred.keyId }, secret: cred.secret, name: "Noted" });
    await goTo("\\\\Perli Cloud");
    await sleep(1500);
    const titles = () => js(`[...Q.active().querySelectorAll('.column-title')].map((t) => t.textContent.trim())`);
    note("titles", await titles());
    note("where", { here: await js(`Q.here()`), crumbs: await js(`Q.crumbs()`), names: await names(), msg: await js(`Q.active().querySelector('.message')?.textContent ?? null`) });
    check("a cloud folder has a Note column", (await titles()).some((t) => t.startsWith("Note")), true);
    const row = () => js(`[...Q.active().querySelectorAll('[role=row]')].map((r) => r.textContent).find((t) => t.includes('Noted')) ?? null`);
    const shows = await waitFor(async () => (await row())?.includes("perli-test"), 6000);
    note("row", await row());
    check("a place's note is its bucket", shows, true);
    await js(`[...Q.active().querySelectorAll('.column-button')].find((b) => b.textContent.trim().startsWith('Note')).click()`);
    await sleep(1200);
    check("sorting by note keeps the rows", (await names()).includes("Noted"), true);
    note("after sort", await names());
    await goTo(home);
    await sleep(800);
    check("a folder here has no Note column", (await titles()).some((t) => t.startsWith("Note")), false);
  });

  await dropPlaces();

  await part("pdf-scripts", async () => {
    await goTo(home);
    await preview("calc.pdf");
    const fields = await waitFor(() => js(`Q.preview()?.querySelectorAll('.annotationLayer input').length === 3`), 8000);
    check("the form's three fields show", fields, true);
    note("chips", await js(`[...Q.preview().querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /Script/.test(t))`));
    const fill = (at, value) =>
      js(`(() => { const i = Q.preview().querySelectorAll('.annotationLayer input')[${at}]; i.focus(); P.type(i, ${JSON.stringify(value)}); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await js(`window.__sb = []; window.addEventListener('updatefromsandbox', (e) => __sb.push(JSON.stringify(e.detail).slice(0, 200)))`);
    note("inputs", await js(`[...Q.preview().querySelectorAll('.annotationLayer input')].map((i) => i.dataset.elementId + ':' + i.name)`));
    await fill(0, "2");
    await sleep(400);
    await fill(1, "3");
    const total = () => js(`Q.preview().querySelectorAll('.annotationLayer input')[2].value`);
    const added = await waitFor(async () => (await total()) === "5", 6000);
    note("total", await total());
    note("sandbox said", await js(`__sb`));
    note("told", await js(`[...document.querySelectorAll('.pdf-told, .toast, [role=status]')].map((t) => t.textContent.trim()).filter(Boolean).slice(0, 5)`));
    const found = await page.send("Runtime.evaluate", { expression: `Q.preview().querySelectorAll('.annotationLayer input')[0]` });
    const heard = await page.send("DOMDebugger.getEventListeners", { objectId: found.result.objectId });
    note("A listens to", (heard.listeners ?? []).map((l) => l.type));
    check("the total adds itself up", added, true);
    await shot("c-pdf-scripts.png", 300);
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
