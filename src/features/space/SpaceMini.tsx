import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { DriveSpace, Places } from "../../api";
import { folderVisits } from "../reach/reach";
import { aim, newScene } from "./draw";
import { brainAims, kindOfCell, pulseIn, readPalette, reducedMotion, sceneLoop, watchPalette } from "./lenses";
import { onPulse } from "./pulses";
import { allNodes, idOf, pcTree, useShares } from "./space";
import { listDrives, weighed } from "./weighed";
import "./space.css";

/** Frames a second for the home page's small Space, which should cost next to nothing. */
const MINI_FPS = 30;

/** This PC in Brain, small, for the home page. A click opens Space. */
export function SpaceMini(props: { drives: Places["drives"]; spaces: Record<string, DriveSpace>; onOpen: () => void }) {
  let canvas!: HTMLCanvasElement;
  let box!: HTMLButtonElement;
  const scene = newScene();
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [palette, setPalette] = createSignal(readPalette());
  let running: ReturnType<typeof sceneLoop> | undefined;

  const tree = createMemo(() =>
    pcTree(
      props.drives
        .filter((drive) => !drive.locked)
        .map((drive) => {
          const space = props.spaces[drive.path];
          return { path: drive.path, name: drive.name, used: space ? space.total - space.free : 0 };
        }),
      weighed(),
      kindOfCell,
    ),
  );

  createEffect(() => {
    const { width, height } = size();
    if (!width || !height) return;
    const now = Date.now();
    const drawn = brainAims(tree(), width, height, palette(), useShares(allNodes(tree()).map((node) => node.id), folderVisits(), now), now);
    aim(scene, drawn.aims, drawn.links, drawn.rows, true, reducedMotion.matches);
    running?.kick();
  });

  const offPulse = onPulse((pulse) => {
    pulseIn(scene, pulse, tree().id, true, size().width);
    running?.kick();
  });

  // With the search index on, each drive shows what fills it before it is ever weighed.
  createEffect(() => listDrives(props.drives.filter((drive) => !drive.locked).map((drive) => ({ path: drive.path, id: idOf(drive.path) }))));

  onMount(() => {
    running = sceneLoop(canvas, scene, palette, MINI_FPS);
    const resize = new ResizeObserver(() => {
      setSize({ width: box.clientWidth, height: box.clientHeight });
      running!.resize(box.clientWidth, box.clientHeight);
    });
    resize.observe(box);
    const unwatch = watchPalette(setPalette);
    onCleanup(() => {
      resize.disconnect();
      unwatch();
    });
  });

  onCleanup(() => {
    running?.stop();
    offPulse();
  });

  return (
    <button ref={box} class="home-card space-mini" aria-label="Open Space: what fills each drive" onClick={props.onOpen}>
      <canvas ref={canvas} aria-hidden="true" />
    </button>
  );
}
