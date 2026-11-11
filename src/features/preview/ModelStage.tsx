import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { ToolCog } from "../../ui/Controls";
import type { ModelView, ReadModel } from "./model";
import { camera, grid, light, setGrid, setLight, setSmooth, smooth, VIEWER_SETTINGS, type CameraStyle } from "./viewerPrefs";

const ICON_RESET = "";
const ICON_TURN = "";
const ICON_WIRE = "";
const ICON_GRID = "";
const ICON_BACKDROP = "";
const ICON_UPRIGHT = "";
const ICON_PLAY = "";
const ICON_PAUSE = "";
const ICON_SMOOTH = "\uE706";
/** Made with Z up, so they start upright. */
const Z_UP = /\.(stl|3mf)$/i;
const MOUSE_WORDS: Record<CameraStyle, string> = {
  perli: "Drag to turn it, right-drag to move it, scroll to zoom.",
  blender: "Drag with the middle button to turn it, hold Shift to move it, scroll to zoom.",
  maya: "Drag to turn it, middle-drag to move it, right-drag or scroll to zoom.",
};


const number = (value: number) => Number(value.toPrecision(3)).toLocaleString();
const count = (amount: number, one: string) => `${amount.toLocaleString()} ${one}${amount === 1 ? "" : "s"}`;

/**
 * A 3D model with its tools in reach: a toolbar on the model and a key for each tool. three.js
 * loads with the first model, and the model is let go of when the preview moves on.
 */
export function ModelStage(live: {
  name: string;
  read: ReadModel;
  keys: (handler: ((event: KeyboardEvent) => boolean) | undefined) => void;
  onFailure: (reason: string) => void;
}) {
  // The preview's props follow the row it shows. This view stays with the file it opened on.
  const props = { ...live };
  const [view, setView] = createSignal<ModelView>();
  const [turning, setTurning] = createSignal(false);
  const [wire, setWire] = createSignal(false);
  const [upright, setUpright] = createSignal(Z_UP.test(props.name));
  const [clip, setClip] = createSignal(0);
  const [paused, setPaused] = createSignal(false);
  let gone = false;

  function start(canvas: HTMLCanvasElement) {
    import("./model")
      .then(({ showModel }) => showModel(canvas, props.name, props.read))
      .then((shown) => {
        if (gone) return shown.dispose();
        setView(shown);
      })
      .catch((reason) => gone || props.onFailure(`This model can't show. ${reason}`));
  }

  const tools: Record<string, () => void> = {
    r: () => view()?.reset(),
    t: () => {
      setTurning(!turning());
      view()?.turn(turning());
    },
    w: () => {
      setWire(!wire());
      view()?.wireframe(wire());
    },
    g: () => setGrid(!grid()),
    s: () => setSmooth(!smooth()),
    b: () => setLight(!light()),
    u: () => {
      setUpright(!upright());
      view()?.upright(upright());
    },
    a: () => {
      const clips = view()?.clips.length ?? 0;
      if (!clips) return;
      // Pauses and goes on from the same place in the same animation.
      setPaused(!paused());
      view()?.pause(paused());
    },
  };

  props.keys((event) => {
    if (event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement && event.target.type !== "range") return false;
    const tool = tools[event.key.toLowerCase()];
    if (!tool || event.shiftKey) return false;
    tool();
    return true;
  });

  // The cog and the settings page change these too, so the model follows them wherever they change.
  createEffect(() => view()?.grid(grid()));
  createEffect(() => view()?.smooth(smooth()));
  createEffect(() => view()?.camera(camera()));

  onCleanup(() => {
    gone = true;
    props.keys(undefined);
    view()?.dispose();
  });

  const facts = () => {
    const shown = view();
    if (!shown) return "";
    upright();
    const { size, triangles, parts, materials } = shown.facts();
    return [
      size.map(number).join(" × "),
      count(triangles, "triangle"),
      count(parts, "part"),
      count(materials, "material"),
    ].join("  ·  ");
  };

  const pickClip = (at: number) => {
    setClip(at);
    setPaused(false);
    view()?.play(at);
  };

  return (
    <div class="preview-model" data-light={light() || undefined}>
      <canvas ref={start} aria-label={`3D model. ${MOUSE_WORDS[camera()]}`} />
      <Show when={view()}>
        <div class="preview-tools" role="toolbar" aria-label="Model">
          <button class="strip-icon" aria-label="Reset view" aria-keyshortcuts="R" onClick={tools.r}>
            {ICON_RESET}
          </button>
          <button class="strip-icon" aria-label="Turn by itself" aria-keyshortcuts="T" aria-pressed={turning()} onClick={tools.t}>
            {ICON_TURN}
          </button>
          <button class="strip-icon" aria-label="Wireframe" aria-keyshortcuts="W" aria-pressed={wire()} onClick={tools.w}>
            {ICON_WIRE}
          </button>
          <button class="strip-icon" aria-label="Floor grid" aria-keyshortcuts="G" aria-pressed={grid()} onClick={tools.g}>
            {ICON_GRID}
          </button>
          <button class="strip-icon" aria-label="Smooth shading" aria-keyshortcuts="S" aria-pressed={smooth()} onClick={tools.s}>
            {ICON_SMOOTH}
          </button>
          <button class="strip-icon" aria-label="Light backdrop" aria-keyshortcuts="B" aria-pressed={light()} onClick={tools.b}>
            {ICON_BACKDROP}
          </button>
          <button class="strip-icon" aria-label="Z up" aria-keyshortcuts="U" aria-pressed={upright()} onClick={tools.u}>
            {ICON_UPRIGHT}
          </button>
          <ToolCog label="Model settings" items={VIEWER_SETTINGS["3D models"]} />
        </div>
        <div class="model-facts">{facts()}</div>
        <Show when={view()!.clips.length}>
          <div class="model-clips" role="group" aria-label="Animations">
            <button
              class="strip-icon"
              aria-label={paused() ? "Play animation" : "Pause animation"}
              aria-keyshortcuts="A"
              onClick={tools.a}
            >
              {paused() ? ICON_PLAY : ICON_PAUSE}
            </button>
            <Show when={view()!.clips.length > 1} fallback={<span>{view()!.clips[0]}</span>}>
              <select
                aria-label="Animation"
                value={clip()}
                onChange={(event) => pickClip(Number(event.currentTarget.value))}
              >
                {view()!.clips.map((name, at) => (
                  <option value={at}>{name}</option>
                ))}
              </select>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}
