import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { fetchPictureFile, findTwins, onJobEvent, runJob, stopTwins, undoJob, type Twin } from "../../api";
import { formatSize } from "../../ui/format";
import { openSheet } from "../../ui/sheet";
import { kindOf } from "../filelist/fileKinds";
import { saved, stored } from "../filelist/prefs";
import { baseName, parentOf } from "../navigation/path";
import { aim, newScene, thingAt, whereIs, type Aim, type LinkAim, type Palette, type Thing } from "./draw";
import { kindRgb, readPalette, reducedMotion, sceneLoop, watchPalette } from "./lenses";
import { goers, idOf, setsOf, twinsLayout, wasted, without, type TwinSet } from "./twins";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "./space.css";

type Mode = "copies" | "alike";
const MODES: { id: Mode; name: string }[] = [
  { id: "copies", name: "Same files" },
  { id: "alike", name: "Look alike" },
];
const [mode, setMode] = stored<Mode>("twins-mode", saved("twins-mode") === "alike" ? "alike" : "copies");
/** How big a picture is fetched to show inside its circle. */
const PICTURE_EDGE = 96;
const MOST_NAME = 26;
const COUNT_MS = 900;
/** Places one click adds to the look, at most. */
const MOST_OFFERS = 5;
const ICON_ADD = "\uE710";
const ICON_REMOVE = "\uE711";

const short = (name: string) => (name.length > MOST_NAME ? `${name.slice(0, MOST_NAME - 2)}…` : name);
const dayOf = (time: number) => new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * Twins: files under a folder with the same content as another, or pictures that look alike,
 * drawn as small clusters. The ringed one of each set stays; cleaning folds the rest into it
 * and sends them to the Recycle Bin, with Undo.
 */
export function Twins(props: {
  /** Where to look, all at once, so twins in two places are found too. */
  folders: string[];
  /** Places one click adds: the other pane's folder and the drives. */
  more: { path: string; name: string }[];
  /** Shows a file in its folder. */
  onShow: (path: string) => void;
  onClose: () => void;
}) {
  /** Undefined while looking. */
  const [sets, setSets] = createSignal<TwinSet[]>();
  const [places, setPlaces] = createSignal(props.folders);
  const [first, setFirst] = createSignal(0);
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [palette, setPalette] = createSignal<Palette>(readPalette());
  const [pictures, setPictures] = createSignal<ReadonlyMap<string, ImageBitmap>>(new Map());
  const [hovered, setHovered] = createSignal<Thing>();
  const [spoken, setSpoken] = createSignal("");
  /** The goers fold into their keepers while they go to the Recycle Bin. */
  const [merging, setMerging] = createSignal(false);
  const [freed, setFreed] = createSignal(0);
  const [counted, setCounted] = createSignal(0);
  /** The undo step of the last clean. */
  const [step, setStep] = createSignal<number | null>(null);
  const [looks, setLooks] = createSignal(0);
  const scene = newScene();
  const asked = new Set<string>();
  let dialog!: HTMLDialogElement;
  let stage!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let close!: ReturnType<typeof openSheet>;
  let loop: ReturnType<typeof sceneLoop> | undefined;
  let ticket = 0;

  const photos = () => mode() === "alike";
  const nameOf = (path: string) => props.more.find((one) => idOf(one.path) === idOf(path))?.name || baseName(path) || path;
  const title = () => (places().length === 1 ? `Twins in ${nameOf(places()[0])}` : `Twins in ${places().length} places`);
  const offers = () => props.more.filter((one) => !places().some((place) => idOf(place) === idOf(one.path))).slice(0, MOST_OFFERS);
  const kick = () => loop?.kick();

  createEffect(
    on([mode, looks, places], ([now, , where]) => {
      const mine = ++ticket;
      batch(() => {
        setSets(undefined);
        setFirst(0);
        setHovered(undefined);
      });
      findTwins(where, now === "alike")
        .then((found) => mine === ticket && setSets(setsOf(found)))
        .catch((error) => {
          if (mine !== ticket) return;
          console.error(error);
          setSets([]);
        });
    }),
  );

  const layout = createMemo(() => twinsLayout(sets() ?? [], first(), size().width, size().height, photos()));
  const page = () => layout().across * layout().down;

  // Cleaning can empty the last page.
  createEffect(() => {
    const count = sets()?.length ?? 0;
    if (first() > 0 && first() >= count) setFirst(Math.max(0, count - page()));
  });

  /** Which set a file is in, and where in it. */
  function whereOf(id: string) {
    const all = sets() ?? [];
    for (let at = 0; at < all.length; at++) {
      const index = all[at].files.findIndex((file) => idOf(file.path) === id);
      if (index >= 0) return { set: all[at], at, index };
    }
  }

  const subOf = (set: TwinSet) => (photos() ? `${set.files.length} alike` : `${set.files.length} copies · ${formatSize(set.files[0].bytes)} each`);

  const drawn = createMemo(() => {
    const { shown, spots } = layout();
    const aims: Aim[] = [];
    const links: LinkAim[] = [];
    for (const set of shown) {
      const keeper = idOf(set.files[set.keep].path);
      const home = spots.get(keeper)!;
      set.files.forEach((file, at) => {
        const id = idOf(file.path);
        const spot = spots.get(id)!;
        const keeps = at === set.keep;
        const gone = merging() && !keeps;
        aims.push({
          id,
          shape: "node",
          x: gone ? home.x : spot.x,
          y: gone ? home.y : spot.y,
          w: gone ? 0 : spot.r * 2,
          h: gone ? 0 : spot.r * 2,
          round: gone ? 0 : spot.r,
          color: kindRgb(kindOf(baseName(file.path), false), palette()),
          glow: keeps ? 1 : 0.7,
          place: keeps,
          label: short(baseName(file.path)),
          sub: keeps ? subOf(set) : undefined,
          quiet: !keeps,
          side: "below",
          image: pictures().get(id),
          about: { path: file.path, bytes: file.bytes },
        });
        if (!keeps) links.push({ a: keeper, b: id, weight: 0.5 });
      });
    }
    return { aims, links };
  });

  createEffect(() => {
    const { aims, links } = drawn();
    aim(scene, aims, links, [], false, reducedMotion.matches);
    if (scene.focus && !aims.some((one) => one.id === scene.focus)) scene.focus = undefined;
    kick();
  });

  // The pictures of the sets in sight, each fetched once.
  createEffect(() => {
    if (!photos()) return;
    for (const set of layout().shown) {
      for (const file of set.files) {
        const id = idOf(file.path);
        if (asked.has(id)) continue;
        asked.add(id);
        fetchPictureFile(file.path, PICTURE_EDGE)
          .then((picture) => picture && createImageBitmap(new ImageData(picture.pixels, picture.width, picture.height)))
          .then((bitmap) => bitmap && setPictures(new Map(pictures()).set(id, bitmap)))
          .catch(() => {});
      }
    }
  });

  // The freed bytes count up to what was freed.
  createEffect(
    on(freed, (to) => {
      if (reducedMotion.matches) return setCounted(to);
      const from = counted();
      const start = performance.now();
      let frame = requestAnimationFrame(function tick(now) {
        const t = Math.min(1, (now - start) / COUNT_MS);
        setCounted(from + (to - from) * (1 - (1 - t) ** 3));
        if (t < 1) frame = requestAnimationFrame(tick);
      });
      onCleanup(() => cancelAnimationFrame(frame));
    }),
  );

  /** Makes `thing` the one its set keeps. */
  function keep(thing: Thing) {
    const found = whereOf(thing.id);
    if (!found || merging() || found.index === found.set.keep) return;
    setSets(sets()!.map((set, at) => (at === found.at ? { ...set, keep: found.index } : set)));
    setSpoken(`${thing.about?.path ? baseName(thing.about.path) : ""} stays`);
  }

  async function clean() {
    const all = sets();
    if (!all || merging()) return;
    const going = all.flatMap(goers);
    if (going.length === 0) return;
    setMerging(true);
    try {
      const end = await runJob({ kind: "recyclePaths", paths: going.map((file) => file.path) });
      if (!end) return;
      if (end.cancelled) {
        // Some may have gone before the stop. Looking again tells which.
        setLooks(looks() + 1);
        return;
      }
      const failed = new Set(end.failed.map((retry) => idOf(retry.source)));
      const gone = going.filter((file) => !failed.has(idOf(file.path)));
      batch(() => {
        setSets(without(all, new Set(gone.map((file) => idOf(file.path)))));
        setFreed(freed() + gone.reduce((sum, file) => sum + file.bytes, 0));
        setStep(end.step);
        setMerging(false);
      });
      setSpoken(`${gone.length.toLocaleString()} moved to the Recycle Bin`);
    } catch (error) {
      console.error(error);
    } finally {
      setMerging(false);
    }
  }

  async function undo() {
    const at = step();
    if (at === null) return;
    setStep(null);
    // The files are back once the undo's job ends; then the sets are looked for again.
    const stop = await onJobEvent((event) => {
      if (event.kind !== "finished") return;
      stop();
      setFreed(0);
      setLooks(looks() + 1);
    });
    undoJob(undefined, at).catch((error) => {
      stop();
      console.error(error);
    });
  }

  function hintOf(thing: Thing) {
    const found = whereOf(thing.id);
    if (!found) return "";
    return found.index === found.set.keep ? "Stays when cleaned · double-click to show it" : "Click to keep this one · double-click to show it";
  }

  function cardOf(thing: Thing): string[] {
    const found = whereOf(thing.id);
    if (!found) return [];
    const file: Twin = found.set.files[found.index];
    const sharpest = Math.max(...found.set.files.map((one) => one.sharp ?? 0));
    const sharp = file.sharp !== null && sharpest > 0 ? `Sharpness ${Math.round((100 * file.sharp) / sharpest)}% of the sharpest` : "";
    return [baseName(file.path), parentOf(file.path) ?? "", `${formatSize(file.bytes)} · ${dayOf(file.modified)}`, sharp, hintOf(thing)];
  }

  const card = createMemo(() => {
    const thing = hovered();
    if (!thing) return undefined;
    const { x, y, w } = whereIs(scene, thing);
    const right = x + w / 2 + 12;
    const flip = right + 260 > size().width;
    return { lines: cardOf(thing).filter(Boolean), x: flip ? x - w / 2 - 12 : right, y: Math.max(8, Math.min(size().height - 80, y - 18)), flip };
  });

  function hover(thing: Thing | undefined) {
    if (thing?.id === scene.hover) return;
    scene.hover = thing?.id;
    setHovered(thing);
    canvas.style.cursor = thing ? "pointer" : "";
    kick();
  }

  const pointAt = (event: MouseEvent) => {
    const box = canvas.getBoundingClientRect();
    return thingAt(scene, event.clientX - box.left, event.clientY - box.top);
  };

  function focusOn(id: string | undefined) {
    const thing = id ? scene.things.get(id) : undefined;
    if (!thing) return;
    scene.focus = thing.id;
    setHovered(thing);
    setSpoken(cardOf(thing).join(". "));
    kick();
  }

  const turnPage = (by: number) => {
    const next = first() + by * page();
    if (next < 0 || next >= (sets()?.length ?? 0)) return;
    setFirst(next);
  };

  function keys(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      return turnPage(event.key === "PageDown" ? 1 : -1);
    }
    if (event.target !== canvas) return;
    const aims = drawn().aims;
    if (event.key.startsWith("Arrow") && aims.length > 0) {
      event.preventDefault();
      const at = aims.findIndex((one) => one.id === scene.focus);
      const by = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      focusOn(aims[at < 0 ? 0 : (at + by + aims.length) % aims.length].id);
    } else if (event.key === "Enter" && scene.focus) {
      event.preventDefault();
      const thing = scene.things.get(scene.focus);
      if (!thing) return;
      if (event.shiftKey && thing.about?.path) return close(() => props.onShow(thing.about!.path!));
      keep(thing);
      focusOn(thing.id);
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
    ticket++;
    loop?.stop();
    stopTwins().catch(console.error);
    for (const bitmap of pictures().values()) bitmap.close();
  });

  const toFree = () => wasted(sets() ?? []);
  const goingCount = () => (sets() ?? []).reduce((sum, set) => sum + set.files.length - 1, 0);

  const status = () => {
    const all = sets();
    if (!all) return photos() ? "Looking for pictures that look alike…" : "Looking for twins…";
    if (all.length === 0) return "";
    return `${all.length.toLocaleString()} ${all.length === 1 ? "set" : "sets"} · ${formatSize(toFree())} to free`;
  };

  const empty = () => {
    const all = sets();
    if (!all) return "";
    if (all.length > 0) return "";
    return photos() ? "No pictures here look alike." : "No twins here. Every file is the only one with its content.";
  };

  const paging = () => {
    const count = sets()?.length ?? 0;
    const shown = layout().shown.length;
    if (count <= shown) return "";
    return `Sets ${(first() + 1).toLocaleString()}–${(first() + shown).toLocaleString()} of ${count.toLocaleString()}`;
  };

  const modeAt = () => Math.max(0, MODES.findIndex((one) => one.id === mode()));

  return (
    <dialog ref={dialog} class="settings confirm space" aria-label="Twins" onClose={props.onClose} onKeyDown={keys}>
      <header class="space-head">
        <div class="space-title">
          <h2>{title()}</h2>
          <p class="settings-note" aria-live="polite">
            {status()}
            <Show when={counted() > 0.5}>
              <span class="twins-freed">
                {status() ? " · " : ""}
                {formatSize(Math.round(counted()))} freed
              </span>
            </Show>
          </p>
          <div class="twins-places" role="group" aria-label="Look in">
            <For each={places()}>
              {(place) => (
                <span class="twins-place">
                  {nameOf(place)}
                  <Show when={places().length > 1}>
                    <button
                      class="twins-place-off"
                      aria-label={`Stop looking in ${nameOf(place)}`}
                      disabled={merging()}
                      onClick={() => setPlaces(places().filter((one) => one !== place))}
                    >
                      {ICON_REMOVE}
                    </button>
                  </Show>
                </span>
              )}
            </For>
            <For each={offers()}>
              {(one) => (
                <button class="twins-place twins-place-add" aria-label={`Look in ${one.name} too`} disabled={merging()} onClick={() => setPlaces([...places(), one.path])}>
                  <span aria-hidden="true">{ICON_ADD}</span>
                  {one.name}
                </button>
              )}
            </For>
          </div>
        </div>
        <div class="space-lenses" role="radiogroup" aria-label="Twins of" style={{ "--at": modeAt(), "--of": MODES.length }}>
          <span class="space-lens-pill" aria-hidden="true" />
          <For each={MODES}>
            {(one) => (
              <button role="radio" aria-checked={one.id === mode()} disabled={merging()} onClick={() => setMode(one.id)}>
                {one.name}
              </button>
            )}
          </For>
        </div>
        <Show when={step() !== null}>
          <button class="space-button" onClick={undo}>
            Undo
          </button>
        </Show>
        <Show when={goingCount() > 0}>
          <button class="space-button twins-clean" disabled={merging()} onClick={clean}>
            Clean {goingCount().toLocaleString()} ({formatSize(toFree())})
          </button>
        </Show>
      </header>
      <div ref={stage} class="space-stage" data-measuring={sets() ? undefined : ""}>
        <canvas
          ref={canvas}
          tabIndex={0}
          role="application"
          aria-label={`${title()}. Arrow keys move between files, Enter keeps the focused one, Shift+Enter shows it in its folder, Page Down and Page Up turn the page.`}
          onPointerMove={(event) => hover(pointAt(event))}
          onPointerLeave={() => hover(undefined)}
          onClick={(event) => {
            const thing = pointAt(event);
            if (thing) keep(thing);
          }}
          onDblClick={(event) => {
            const path = pointAt(event)?.about?.path;
            if (path) close(() => props.onShow(path));
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
        <ul class="space-unseen" aria-label="Files">
          <For each={drawn().aims}>
            {(one) => (
              <li>
                <button
                  tabIndex={-1}
                  onClick={() => {
                    const thing = scene.things.get(one.id);
                    if (thing) keep(thing);
                  }}
                >
                  {[one.label, one.place ? "stays" : "goes"].join(", ")}
                </button>
              </li>
            )}
          </For>
        </ul>
        <p class="space-unseen" aria-live="polite">
          {spoken()}
        </p>
      </div>
      <footer class="twins-foot">
        <p class="settings-note">The ringed one of each set stays: the oldest copy, or the sharpest picture. Click another to keep it instead. Cleaning moves the rest to the Recycle Bin.</p>
        <Show when={paging()}>
          <div class="twins-pages">
            <button class="space-button" disabled={first() === 0} aria-keyshortcuts="PageUp" onClick={() => turnPage(-1)}>
              Previous
            </button>
            <span class="settings-note">{paging()}</span>
            <button class="space-button" disabled={layout().left === 0} aria-keyshortcuts="PageDown" onClick={() => turnPage(1)}>
              Next
            </button>
          </div>
        </Show>
      </footer>
    </dialog>
  );
}
