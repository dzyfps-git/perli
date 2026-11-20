import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { driveSpace, folderStamp, listTags, mapFolder, onMapGrew, saveSpacePicture, stopMap, taggedUnder, type MapCell, type Places, type Tag, type TaggedFile } from "../../api";
import { formatSize } from "../../ui/format";
import { openSheet } from "../../ui/sheet";
import { saved, stored } from "../filelist/prefs";
import { baseName, parentOf } from "../navigation/path";
import { folderVisits } from "../reach/reach";
import { aim, newScene, sendComet, thingAt, whereIs, type Palette, type Thing } from "./draw";
import {
  brainAims,
  cellsAims,
  kindOfCell,
  layersAims,
  LENSES,
  MOST_CELLS,
  pulseIn,
  readPalette,
  reducedMotion,
  sceneLoop,
  skyOver,
  tagsAims,
  watchPalette,
  type Drawn,
  type Lens,
} from "./lenses";
import { onPulse } from "./pulses";
import { agoText, allNodes, folderTree, idOf, joinPath, nearestShown, pcTree, touches, useShares } from "./space";
import { keepWeighed, listDrives, weighed, weighedYears } from "./weighed";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "./space.css";

const ICON_UP = "";
const ICON_SEARCH = "";
/** Parts a screen reader can step through. A canvas has none of its own. */
const MOST_LISTED = 150;
/** How often Downloads is looked at for something new, while Space is open. */
const DOWNLOADS_EVERY_MS = 4000;
const [lens, setLens] = stored<Lens>("space-lens", LENSES.some((one) => one.id === saved("space-lens")) ? (saved("space-lens") as Lens) : "brain");
const EMPTY: Drawn = { aims: [], links: [], rows: [], left: 0 };
let tickets = 0;

const NOTES: Record<Lens, string> = {
  brain: "Each part is as big as what it holds and dims the longer it goes untouched. Links grow stronger with the folders you visit. Click a folder to step in.",
  cells: "A circle is as big as everything under it. Click a folder to look inside, or a file to show it in its folder.",
  layers: "Each band is a year, as thick as the files last changed that year, split among the parts that hold them. Click a slice to step into its folder.",
  tags: "Each tag is a star, and each tagged file a speck near the stars of its tags. Click a star to pick out its files.",
};

/** A file name for the saved picture, with nothing Windows keeps out of names. */
const fileNameOf = (text: string) => text.replace(/[\\/:*?"<>|]+|\.{2,}/g, " ").replace(/\s+/g, " ").trim();

/**
 * Space: what fills a folder or the whole PC, seen through four lenses that melt into each other.
 * Folders fill in as they are weighed, and copies, moves and downloads show as light moving along it.
 */
export function Space(props: {
  /** The folder to start on. "" is This PC. */
  folder: string;
  drives: Places["drives"];
  pictures?: string;
  downloads?: string;
  /** Opens a folder in the file list. */
  onOpen: (path: string) => void;
  /** Shows a file in its folder. */
  onShow: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = createSignal(props.folder);
  const [cells, setCells] = createSignal<MapCell[]>(weighed()[idOf(props.folder)] ?? []);
  const [done, setDone] = createSignal(false);
  const [used, setUsed] = createSignal<Record<string, number>>({});
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [palette, setPalette] = createSignal<Palette>(readPalette());
  const [query, setQuery] = createSignal("");
  /** The files of the star picked in Tags. */
  const [picked, setPicked] = createSignal<ReadonlySet<string>>();
  const [tags, setTags] = createSignal<Tag[]>([]);
  const [tagged, setTagged] = createSignal<TaggedFile[]>([]);
  const [hovered, setHovered] = createSignal<Thing>();
  const [spoken, setSpoken] = createSignal("");
  const [savedTo, setSavedTo] = createSignal<string>();
  const scene = newScene();
  let dialog!: HTMLDialogElement;
  let stage!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let find!: HTMLInputElement;
  let close!: ReturnType<typeof openSheet>;
  let loop: ReturnType<typeof sceneLoop> | undefined;
  let ticket = 0;
  /** What the first answer of a weigh listed: everything in the folder. */
  let listed: Set<string> | undefined;

  const atPc = () => path() === "";
  const drives = () => props.drives.filter((drive) => !drive.locked);
  const title = () => {
    if (atPc()) return "This PC";
    return baseName(path()) || drives().find((drive) => drive.path.toLowerCase() === path().toLowerCase())?.name || path();
  };
  const total = () => (atPc() ? Object.values(used()).reduce((sum, bytes) => sum + bytes, 0) : cells().reduce((sum, cell) => sum + cell.bytes, 0));

  const pc = () => pcTree(drives().map((drive) => ({ path: drive.path, name: drive.name, used: used()[drive.path] ?? 0 })), weighed(), kindOfCell, weighedYears());
  const treeOf = (most?: number) => (atPc() ? pc() : folderTree(path(), title(), cells(), kindOfCell, most));
  /** The tree Brain draws, which also finds where pulses go. */
  const tree = createMemo(() => treeOf());

  const drawn = createMemo((): Drawn => {
    const { width, height } = size();
    if (!width || !height) return EMPTY;
    const now = Date.now();
    switch (lens()) {
      case "brain": {
        const ids = allNodes(tree()).map((node) => node.id);
        return brainAims(tree(), width, height, palette(), useShares(ids, folderVisits(), now), now);
      }
      case "cells":
        return cellsAims(treeOf(MOST_CELLS), width, height, palette(), now);
      case "layers":
        return layersAims(atPc() ? pc() : treeOf(cells().length), width, height, palette());
      case "tags":
        return tagsAims(tags(), tagged(), width, height, palette());
    }
  });

  createEffect(() => {
    const { aims, links, rows } = drawn();
    aim(scene, aims, links, rows, lens() === "brain", reducedMotion.matches);
    if (scene.focus && !aims.some((one) => one.id === scene.focus)) scene.focus = undefined;
    kick();
  });

  createEffect(() => {
    const words = query().trim().toLowerCase();
    const found = words ? new Set(drawn().aims.filter((one) => one.label?.toLowerCase().includes(words)).map((one) => one.id)) : undefined;
    scene.found = found ?? picked();
    if (found) setSpoken(`${found.size.toLocaleString()} found`);
    kick();
  });

  // A pick belongs to the stars it was made among, and a card to the part it was shown for.
  createEffect(
    on(
      [lens, path],
      () => {
        setPicked(undefined);
        setHovered(undefined);
        scene.hover = undefined;
      },
      { defer: true },
    ),
  );

  // Weighing. The first answer lists everything in the folder, its folders not yet weighed.
  const off = onMapGrew((grew) => {
    if (grew.ticket !== ticket) return;
    const first = !listed;
    if (first) listed = new Set(grew.cells.map((cell) => cell.name));
    const known = new Map(cells().map((cell) => [cell.name, cell]));
    for (const cell of grew.cells) {
      const held = known.get(cell.name);
      // A folder weighed before keeps its old size until it is weighed again, so nothing shrinks and grows back.
      known.set(cell.name, first && cell.folder && held && held.bytes > 0 ? held : cell);
    }
    const next = [...known.values()].filter((cell) => listed!.has(cell.name));
    setCells(next);
    setDone(grew.done);
    if (grew.done) keepWeighed(idOf(path()), next);
  });

  /** Weighs `folder` afresh, or stops weighing for This PC. */
  function weigh(folder: string) {
    ticket = ++tickets;
    listed = undefined;
    if (!folder) {
      setDone(true);
      stopMap().catch(console.error);
      listDrives(drives().map((drive) => ({ path: drive.path, id: idOf(drive.path) })));
      return;
    }
    setDone(false);
    mapFolder(folder, ticket).catch(console.error);
  }

  createEffect(
    on(path, (folder) => {
      setSavedTo(undefined);
      weigh(folder);
    }),
  );

  /** Steps into a folder, starting from what is known of it so it shows at once. */
  function enter(folder: string) {
    const id = idOf(folder);
    const known = weighed()[id] ?? cells().find((cell) => idOf(joinPath(path(), cell.name)) === id)?.inner ?? [];
    batch(() => {
      setCells(known);
      setPath(folder);
    });
  }

  function up() {
    if (atPc()) return;
    enter(parentOf(path()) ?? "");
  }

  // Tags: the tagged files under the folder, or anywhere for This PC.
  createEffect(
    on([lens, path], ([now, folder]) => {
      if (now !== "tags") return;
      let live = true;
      Promise.all([listTags(), taggedUnder(folder)])
        .then(([all, files]) => {
          if (!live) return;
          setTags(all);
          setTagged(files);
        })
        .catch(console.error);
      onCleanup(() => (live = false));
    }),
  );

  /** Asks how full each drive is: each one as it is first listed, and all of them `again` after a job. */
  const asked = new Set<string>();
  function readUsed(again = false) {
    for (const drive of props.drives) {
      if (drive.locked || (!again && asked.has(drive.path))) continue;
      asked.add(drive.path);
      driveSpace(drive.path)
        .then((space) => space.total > 0 && setUsed({ ...used(), [drive.path]: space.total - space.free }))
        .catch(() => {});
    }
  }
  // A drive plugged in while Space is open gets its fill too.
  createEffect(() => readUsed());

  const kick = () => loop?.kick();

  const offPulse = onPulse((pulse) => {
    pulseIn(scene, pulse, tree().id, lens() === "brain", size().width);
    kick();
    // A job that changed what shows here has the sizes weighed again, not only drawn as light.
    if (!touches(pulse, path())) return;
    if (path()) weigh(path());
    else readUsed(true);
  });

  // Something new in Downloads falls in from above.
  let stamp: number | undefined;
  const watch = props.downloads
    ? setInterval(() => {
        folderStamp(props.downloads!)
          .then((now) => {
            if (stamp !== undefined && now !== stamp) {
              const shown = new Set([...scene.things.values()].filter((thing) => thing.alpha > 0).map((thing) => thing.id));
              const where = nearestShown(props.downloads!, shown, tree().id);
              if (where) sendComet(scene, [where], false, skyOver(scene, where, size().width));
              kick();
            }
            stamp = now;
          })
          .catch(() => {});
      }, DOWNLOADS_EVERY_MS)
    : undefined;

  /** What a click or Enter on a thing does. */
  function act(thing: Thing) {
    if (thing.shape === "star") {
      const tag = thing.about?.tag;
      const files = new Set(tagged().filter((file) => tag !== undefined && file.tags.includes(tag)).map((file) => idOf(file.path)));
      files.add(thing.id);
      setPicked(picked()?.has(thing.id) ? undefined : files);
      return;
    }
    if (thing.shape === "speck") {
      const file = thing.about?.path;
      if (file) close(() => props.onShow(file));
      return;
    }
    const node = thing.node;
    if (!node) return;
    if (node.folded) return setLens("cells");
    if (node.depth === 0) return;
    if (node.folder) enter(node.path);
    else close(() => props.onShow(node.path));
  }

  function hintOf(thing: Thing) {
    if (thing.shape === "star") return "Click to pick out its files";
    if (thing.shape === "speck") return "Click to show it in its folder";
    const node = thing.node;
    if (!node) return "";
    if (node.folded) return "Click to see them as cells";
    if (node.depth === 0) return "";
    return node.folder ? "Click to look inside" : "Click to show it in its folder";
  }

  /** The hover card's lines. */
  function cardOf(thing: Thing): string[] {
    const node = thing.node;
    if (thing.shape === "star") return [`${thing.label}: ${thing.sub}`, hintOf(thing)];
    if (thing.shape === "speck") return [thing.label ?? "", thing.about?.path ?? "", hintOf(thing)];
    if (thing.shape === "brick") {
      const owner = node?.name ?? "Everything else";
      return [`${owner} · ${thing.about?.year}: ${formatSize(thing.about?.bytes ?? 0)}`, node ? hintOf(thing) : ""];
    }
    if (!node) return [thing.label ?? ""];
    const age = node.place || node.folded ? "" : ` · ${agoText(node.newest, Date.now())}`;
    return [node.name, `${formatSize(node.bytes)}${age}`, hintOf(thing)];
  }

  const card = createMemo(() => {
    const thing = hovered();
    if (!thing) return undefined;
    const { x, y, w } = whereIs(scene, thing);
    const right = x + w / 2 + 12;
    const flip = right + 260 > size().width;
    return { lines: cardOf(thing).filter(Boolean), x: flip ? x - w / 2 - 12 : right, y: Math.max(8, Math.min(size().height - 60, y - 18)), flip };
  });

  function hover(thing: Thing | undefined) {
    if (thing?.id === scene.hover) return;
    scene.hover = thing?.id;
    setHovered(thing);
    canvas.style.cursor = thing && hintOf(thing) ? "pointer" : "";
    kick();
  }

  const pointAt = (event: PointerEvent | MouseEvent) => {
    const box = canvas.getBoundingClientRect();
    return thingAt(scene, event.clientX - box.left, event.clientY - box.top);
  };

  /** Moves the keyboard's focus to `id` and says what it is. */
  function focusOn(id: string | undefined) {
    const thing = id ? scene.things.get(id) : undefined;
    if (!thing) return;
    scene.focus = thing.id;
    setHovered(thing);
    setSpoken(cardOf(thing).join(". "));
    kick();
  }

  /** The way an arrow goes from the focused thing. Brain follows the tree; the rest go in order. */
  function arrow(key: string) {
    const aims = drawn().aims;
    if (aims.length === 0) return;
    const at = aims.findIndex((one) => one.id === scene.focus);
    if (at < 0) return focusOn(aims[0].id);
    const node = aims[at].node;
    if (lens() === "brain" && node) {
      const kin = node.parent?.kids ?? [];
      const sibling = (by: number) => kin[(kin.indexOf(node) + by + kin.length) % kin.length]?.id;
      const next = { ArrowUp: node.parent?.id, ArrowDown: node.kids[0]?.id, ArrowLeft: sibling(-1), ArrowRight: sibling(1) }[key];
      return focusOn(next);
    }
    const by = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
    focusOn(aims[(at + by + aims.length) % aims.length].id);
  }

  function keys(event: KeyboardEvent) {
    if (event.target === find) {
      if (event.key === "Escape" && query()) {
        event.preventDefault();
        setQuery("");
      }
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const pick = LENSES[Number(event.key) - 1];
    if (pick && event.key.length === 1) {
      event.preventDefault();
      return setLens(pick.id);
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      return up();
    }
    if (event.key === "/") {
      event.preventDefault();
      return find.focus();
    }
    if (event.target !== canvas) return;
    if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      arrow(event.key);
    } else if (event.key === "Enter" && scene.focus) {
      event.preventDefault();
      const thing = scene.things.get(scene.focus);
      if (thing) act(thing);
    }
  }

  async function savePicture() {
    const pictures = props.pictures;
    if (!pictures) return;
    const flat = document.createElement("canvas");
    flat.width = canvas.width;
    flat.height = canvas.height;
    const drawing = flat.getContext("2d")!;
    const [red, green, blue] = palette().surface;
    drawing.fillStyle = `rgb(${red},${green},${blue})`;
    drawing.fillRect(0, 0, flat.width, flat.height);
    drawing.drawImage(canvas, 0, 0);
    const png = await new Promise<Blob | null>((done) => flat.toBlob(done, "image/png"));
    if (!png) return;
    const day = new Date().toLocaleDateString("sv-SE");
    try {
      setSavedTo(await saveSpacePicture(pictures, fileNameOf(`Space of ${title()} ${day}`), await png.arrayBuffer()));
    } catch (error) {
      console.error(error);
    }
  }

  onMount(() => {
    close = openSheet(dialog);
    loop = sceneLoop(canvas, scene, palette);
    const resize = new ResizeObserver(() => {
      setSize({ width: stage.clientWidth, height: stage.clientHeight });
      loop!.resize(stage.clientWidth, stage.clientHeight);
    });
    resize.observe(stage);
    // The theme or the accent can change while Space is open.
    const unwatch = watchPalette((next) => {
      setPalette(next);
      kick();
    });
    onCleanup(() => {
      resize.disconnect();
      unwatch();
    });
  });

  onCleanup(() => {
    loop?.stop();
    clearInterval(watch);
    offPulse();
    off.then((stop) => stop());
    stopMap().catch(console.error);
  });

  const status = () => {
    if (atPc()) return `${formatSize(total())} used on ${drives().length} ${drives().length === 1 ? "drive" : "drives"}`;
    const count = cells().length;
    return `${formatSize(total())}${done() ? ` in ${count.toLocaleString()} ${count === 1 ? "item" : "items"}` : " so far, still adding up…"}`;
  };

  const empty = () => {
    if (drawn().aims.length > 0 || !size().width) return "";
    if (lens() === "layers" && atPc()) return "Open a drive once to see its years in layers.";
    if (lens() === "tags") return "Nothing here wears a tag yet.";
    if (!done()) return "Adding up…";
    return "Nothing in this folder.";
  };

  const footer = () => {
    const left = drawn().left;
    if (left === 0) return NOTES[lens()];
    const what = lens() === "tags" ? "tagged files are" : "smaller items are";
    return `${NOTES[lens()]} ${left.toLocaleString()} ${left === 1 ? what.replace("files are", "file is").replace("items are", "item is") : what} not drawn.`;
  };

  const lensAt = () => Math.max(0, LENSES.findIndex((one) => one.id === lens()));

  return (
    <dialog ref={dialog} class="settings confirm space" aria-label="Space" onClose={props.onClose} onKeyDown={keys}>
      <header class="space-head">
        <button class="space-button space-up" aria-label="Up one folder" aria-keyshortcuts="Backspace" disabled={atPc()} onClick={up}>
          {ICON_UP}
        </button>
        <div class="space-title">
          <h2>{title()}</h2>
          <p class="settings-note" aria-live="polite">
            <Show when={savedTo()} fallback={status()}>
              Saved in Pictures.{" "}
              <button class="space-link" onClick={() => close(() => props.onShow(savedTo()!))}>
                Show
              </button>
            </Show>
          </p>
        </div>
        <div class="space-lenses" role="radiogroup" aria-label="Lens" style={{ "--at": lensAt(), "--of": LENSES.length }}>
          <span class="space-lens-pill" aria-hidden="true" />
          <For each={LENSES}>
            {(one, at) => (
              <button role="radio" aria-checked={one.id === lens()} aria-keyshortcuts={String(at() + 1)} onClick={() => setLens(one.id)}>
                {one.name}
              </button>
            )}
          </For>
        </div>
        <label class="space-find">
          <span aria-hidden="true">{ICON_SEARCH}</span>
          <input ref={find} type="search" placeholder="Find" aria-label="Find in Space" aria-keyshortcuts="/" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <Show when={props.pictures}>
          <button class="space-button" onClick={savePicture}>
            Save picture
          </button>
        </Show>
        <Show when={!atPc()}>
          <button class="space-button" onClick={() => close(() => props.onOpen(path()))}>
            Open this folder
          </button>
        </Show>
      </header>
      <div ref={stage} class="space-stage" data-measuring={done() ? undefined : ""}>
        <canvas
          ref={canvas}
          tabIndex={0}
          role="application"
          aria-label={`${title()} in Space. Arrow keys move between parts, Enter steps in, Backspace goes up, 1 to 4 change the lens.`}
          onPointerMove={(event) => hover(pointAt(event))}
          onPointerLeave={() => hover(undefined)}
          onClick={(event) => {
            const thing = pointAt(event);
            if (thing) act(thing);
          }}
          onFocus={() => scene.focus || focusOn(drawn().aims[0]?.id)}
          onBlur={() => {
            scene.focus = undefined;
            kick();
          }}
        />
        <Show when={card()}>
          {(shown) => (
            <div class="space-card" data-flip={shown().flip ? "" : undefined} style={{ left: `${shown().x}px`, top: `${shown().y}px` }} aria-hidden="true">
              <For each={shown().lines}>{(line, at) => <span class={at() === 0 ? "space-card-name" : undefined}>{line}</span>}</For>
            </div>
          )}
        </Show>
        <Show when={empty()}>
          <p class="space-empty">{empty()}</p>
        </Show>
        <ul class="space-unseen" aria-label="Parts">
          <For each={drawn().aims.slice(0, MOST_LISTED)}>
            {(one) => (
              <li>
                <button
                  tabIndex={-1}
                  onClick={() => {
                    const thing = scene.things.get(one.id);
                    if (thing) act(thing);
                  }}
                >
                  {[one.label, one.sub].filter(Boolean).join(", ")}
                </button>
              </li>
            )}
          </For>
        </ul>
        <p class="space-unseen" aria-live="polite">
          {spoken()}
        </p>
      </div>
      <p class="settings-note">{footer()}</p>
    </dialog>
  );
}
