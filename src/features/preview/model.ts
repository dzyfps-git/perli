/**
 * A 3D model in the quick preview, turned with the mouse: glTF, GLB, OBJ and STL, and USD, FBX,
 * PLY and 3MF, whose readers load with the first file of their kind. three.js is big, so this
 * file loads only when the first model opens.
 */
import {
  AnimationMixer,
  Box3,
  Clock,
  GridHelper,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  MOUSE,
  PerspectiveCamera,
  PMREMGenerator,
  Points,
  PointsMaterial,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
  type AnimationAction,
  type AnimationClip,
  type BufferGeometry,
  type Material,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { CameraStyle } from "./viewerPrefs";

/** The model's bytes, or with `part` those of a file beside it that it points to. */
export type ReadModel = (part?: string) => Promise<ArrayBuffer>;

/** What the preview's buttons and keys can do with a model on show. */
export interface ModelView {
  /** Size across, up and deep, then triangles, parts and materials. */
  facts: () => { size: [number, number, number]; triangles: number; parts: number; materials: number };
  /** The model's animations, by name. */
  clips: string[];
  /** Springs back to the first view. */
  reset: () => void;
  turn: (on: boolean) => void;
  wireframe: (on: boolean) => void;
  grid: (on: boolean) => void;
  /** Curved surfaces look curved, or every triangle shows as a flat face. */
  smooth: (on: boolean) => void;
  /** Which mouse buttons turn, move and zoom. */
  camera: (style: CameraStyle) => void;
  /** Stands a model made with Z up the right way, or back. */
  upright: (on: boolean) => void;
  /** Plays one animation from its start. */
  play: (clip: number) => void;
  /** Holds the animation playing where it is, or goes on from there. */
  pause: (on: boolean) => void;
  dispose: () => void;
}

const FIELD_OF_VIEW = 40;
/** Room around the model when it first shows. */
const FIT_MARGIN = 1.15;
/** A model arrives from this much further back. */
const ARRIVE_FROM = 1.8;
const SPRING_MS = 700;
const PLAIN = 0xb8bcc4;
const GRID_COLOR = 0x8a8f99;
const GRID_LINES = 20;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
/** Edges sharper than this stay sharp when a surface is smoothed. */
const CREASE = Math.PI / 4;
/** Made with Z up, by their own rules or by habit. */
const Z_UP = ["stl", "3mf"];
const USD = ["usdz", "usd", "usda", "usdc"];
/** Shift with the turning button moves the model, in every style. */
const MOUSE_BUTTONS: Record<CameraStyle, { LEFT: MOUSE; MIDDLE: MOUSE; RIGHT: MOUSE }> = {
  perli: { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN },
  blender: { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.ROTATE, RIGHT: MOUSE.PAN },
  maya: { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.DOLLY },
};
const MAP_KEYS = ["map_kd", "map_ks", "map_ke", "map_d", "map_bump", "bump", "norm", "disp"];

/** A spring like the CSS one: overshoots a little, then settles at 1. */
function spring(t: number) {
  const zeta = 0.55;
  const omega = 13;
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  const seconds = t * (SPRING_MS / 1000);
  return 1 - Math.exp(-zeta * omega * seconds) * (Math.cos(damped * seconds) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(damped * seconds));
}

/** Shows the model in `canvas`. STL and 3MF files start upright, as they are made with Z up. */
export async function showModel(canvas: HTMLCanvasElement, name: string, read: ReadModel): Promise<ModelView> {
  const urls: string[] = [];
  const extension = name.split(".").pop()!.toLowerCase();
  const { model, clips } = await load(extension, read, urls);
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(devicePixelRatio);
  const scene = new Scene();
  const environment = new PMREMGenerator(renderer);
  scene.environment = environment.fromScene(new RoomEnvironment(), 0.04).texture;
  environment.dispose();
  scene.add(model);

  const camera = new PerspectiveCamera(FIELD_OF_VIEW, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.autoRotateSpeed = 1.5;
  const home = { position: new Vector3(), target: new Vector3() };
  let floor: GridHelper | undefined;
  let showFloor = false;
  let flight: { from: Vector3; fromTarget: Vector3; start: number } | undefined;
  const mixer = clips.length ? new AnimationMixer(model) : undefined;
  let action: AnimationAction | undefined;
  const clock = new Clock();

  /** Works out the first view, and where the floor goes, for the model as it now stands. */
  function measure() {
    model.updateMatrixWorld(true);
    const box = new Box3().setFromObject(model);
    const sphere = box.getBoundingSphere(new Sphere());
    const radius = sphere.radius || 1;
    const distance = (radius * FIT_MARGIN) / Math.sin(((FIELD_OF_VIEW / 2) * Math.PI) / 180);
    camera.near = distance / 100;
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    home.target.copy(sphere.center);
    home.position.copy(sphere.center).add(new Vector3(0.6, 0.45, 1).normalize().multiplyScalar(distance));
    if (floor) {
      scene.remove(floor);
      floor.dispose();
    }
    floor = new GridHelper(radius * 4, GRID_LINES, GRID_COLOR, GRID_COLOR);
    for (const material of [floor.material].flat()) Object.assign(material, { transparent: true, opacity: 0.35 });
    floor.position.set(sphere.center.x, box.min.y, sphere.center.z);
    floor.visible = showFloor;
    scene.add(floor);
  }

  /** Flies the camera home from `from` on a spring, or jumps there when motion is reduced. */
  function flyHome(from: Vector3, fromTarget: Vector3) {
    if (reducedMotion.matches) {
      camera.position.copy(home.position);
      controls.target.copy(home.target);
      controls.update();
      draw();
      return;
    }
    flight = { from: from.clone(), fromTarget: fromTarget.clone(), start: performance.now() };
    wake();
  }

  const draw = () => renderer.render(scene, camera);
  const busy = () => !!flight || controls.autoRotate || (!!action && !action.paused);

  function frame() {
    const delta = clock.getDelta();
    if (flight) {
      const t = Math.min(1, (performance.now() - flight.start) / SPRING_MS);
      const k = t < 1 ? spring(t) : 1;
      camera.position.lerpVectors(flight.from, home.position, k);
      controls.target.lerpVectors(flight.fromTarget, home.target, k);
      if (t >= 1) flight = undefined;
    }
    mixer?.update(delta);
    // A change draws by itself.
    if (!controls.update(delta)) draw();
    if (!busy()) renderer.setAnimationLoop(null);
  }

  function wake() {
    clock.getDelta();
    renderer.setAnimationLoop(frame);
  }

  controls.addEventListener("change", () => draw());
  measure();
  if (Z_UP.includes(extension)) upright(true);
  const away = home.position.clone().sub(home.target).multiplyScalar(ARRIVE_FROM).add(home.target);
  camera.position.copy(away);
  controls.target.copy(home.target);
  flyHome(away, home.target);
  if (mixer) play(0);

  function upright(on: boolean) {
    model.rotation.x = on ? -Math.PI / 2 : 0;
    measure();
    flyHome(camera.position, controls.target);
  }

  function play(clip: number) {
    if (!mixer) return;
    mixer.stopAllAction();
    action = mixer.clipAction(clips[clip]);
    action.paused = false;
    action.play();
    wake();
  }

  function pause(on: boolean) {
    if (!action) return;
    action.paused = on;
    if (!on) wake();
  }

  const resize = () => {
    const { clientWidth: width, clientHeight: height } = canvas.parentElement!;
    if (!width || !height) return;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    draw();
  };
  const watcher = new ResizeObserver(resize);
  watcher.observe(canvas.parentElement!);
  resize();

  const meshes = () => {
    const found: Mesh[] = [];
    model.traverse((part) => part instanceof Mesh && found.push(part));
    return found;
  };

  return {
    facts: () => {
      const size = new Box3().setFromObject(model).getSize(new Vector3());
      const all = meshes();
      const triangles = all.reduce((sum, mesh) => {
        const geometry = mesh.geometry;
        return sum + Math.floor((geometry.index?.count ?? geometry.attributes.position?.count ?? 0) / 3);
      }, 0);
      const materials = new Set(all.flatMap((mesh) => [mesh.material].flat())).size;
      return { size: [size.x, size.y, size.z], triangles, parts: all.length, materials };
    },
    clips: clips.map((clip, at) => clip.name || `Animation ${at + 1}`),
    reset: () => flyHome(camera.position, controls.target),
    turn: (on) => {
      controls.autoRotate = on;
      if (on) wake();
    },
    wireframe: (on) => {
      for (const mesh of meshes()) for (const material of [mesh.material].flat()) Object.assign(material, { wireframe: on });
      draw();
    },
    grid: (on) => {
      showFloor = on;
      if (floor) floor.visible = on;
      draw();
    },
    smooth: (on) => {
      for (const mesh of meshes()) {
        for (const material of [mesh.material].flat()) Object.assign(material, { flatShading: !on, needsUpdate: true });
      }
      draw();
    },
    camera: (style) => {
      controls.mouseButtons = MOUSE_BUTTONS[style];
    },
    upright,
    play,
    pause,
    dispose: () => {
      renderer.setAnimationLoop(null);
      watcher.disconnect();
      controls.dispose();
      mixer?.stopAllAction();
      scene.traverse((part) => {
        if (!(part instanceof Mesh || part instanceof Points)) return;
        part.geometry.dispose();
        for (const material of [part.material].flat() as Material[]) {
          for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
          material.dispose();
        }
      });
      floor?.dispose();
      scene.environment?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      for (const url of urls) URL.revokeObjectURL(url);
    },
  };
}

async function load(extension: string, read: ReadModel, urls: string[]): Promise<{ model: Object3D; clips: AnimationClip[] }> {
  const bytes = await read();
  if (extension === "stl") return { model: surface(new STLLoader().parse(bytes)), clips: [] };
  if (extension === "ply") {
    const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
    const geometry = new PLYLoader().parse(bytes);
    // A scan with no faces has no index.
    return { model: surface(geometry, !geometry.index), clips: [] };
  }
  if (extension === "3mf") {
    const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
    return { model: new ThreeMFLoader(offline()).parse(bytes), clips: [] };
  }
  if (extension === "fbx") {
    const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
    const model = new FBXLoader(offline()).parse(bytes, "");
    return { model, clips: model.animations };
  }
  if (USD.includes(extension)) {
    const { USDLoader } = await import("three/examples/jsm/loaders/USDLoader.js");
    // The pictures inside arrive after the shapes, and the model shows once it has them.
    const model = await new Promise<Object3D>((done, failed) => new USDLoader(offline()).parse(bytes, "", done, failed));
    return { model, clips: model.animations };
  }
  if (extension === "obj") return { model: await obj(new TextDecoder().decode(bytes), read, urls), clips: [] };
  const json = extension === "glb" ? glbJson(bytes) : JSON.parse(new TextDecoder().decode(bytes));
  const loader = new GLTFLoader(await localParts(json, read, urls));
  const found = await loader.parseAsync(bytes, "");
  return { model: found.scene, clips: found.animations };
}

/**
 * One surface with no materials of its own, in its colors if it has them. Its triangles share no
 * corners, so the normals are worked out here, and edges sharper than `CREASE` stay sharp. A file
 * of points with no triangles shows as its points.
 */
function surface(geometry: BufferGeometry, points = false) {
  const colored = geometry.hasAttribute("color");
  const color = colored ? 0xffffff : PLAIN;
  if (points) return new Points(geometry, new PointsMaterial({ color, vertexColors: colored, size: 2, sizeAttenuation: false }));
  return new Mesh(toCreasedNormals(geometry, CREASE), new MeshStandardMaterial({ color, vertexColors: colored }));
}

/** Lets a reader use what is packed inside the file, and nothing from the web or the disk. */
function offline() {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => (/^(blob|data):/.test(url) ? url : "data:,"));
  return manager;
}

/** Reads a file the model points to, as a URL for three.js, or nothing if it isn't there. */
async function partUrl(uri: string, read: ReadModel, urls: string[]) {
  let name = uri;
  try {
    name = decodeURIComponent(uri);
  } catch {
    // A stray % is part of the name.
  }
  const bytes = await read(name).catch(() => undefined);
  if (!bytes) return undefined;
  const url = URL.createObjectURL(new Blob([bytes]));
  urls.push(url);
  return url;
}

/**
 * An OBJ with the colors and pictures of its .mtl files, read from beside it. Without them, or
 * where they can't be read, it is plain grey.
 */
async function obj(text: string, read: ReadModel, urls: string[]) {
  const libraries = [...text.matchAll(/^mtllib\s+(.+?)\s*$/gm)].map((match) => match[1]);
  const loader = new OBJLoader();
  let colored = false;
  for (const library of libraries) {
    const bytes = await read(library).catch(() => undefined);
    if (!bytes) continue;
    const found = new Map<string, string>();
    const manager = new LoadingManager();
    manager.setURLModifier((url) => found.get(url) ?? "data:,");
    const materials = new MTLLoader(manager).parse(new TextDecoder().decode(bytes), "");
    const pictures = new Set<string>();
    for (const info of Object.values(materials.materialsInfo)) {
      for (const [key, value] of Object.entries(info)) {
        if (MAP_KEYS.includes(key.toLowerCase()) && typeof value === "string") pictures.add(materials.getTextureParams(value, {}).url);
      }
    }
    await Promise.all(
      [...pictures].map(async (picture) => {
        const url = await partUrl(picture, read, urls);
        if (url) found.set(picture, url);
      }),
    );
    // A picture that isn't beside the model would draw black, so its surface keeps its color.
    for (const info of Object.values(materials.materialsInfo) as Record<string, unknown>[]) {
      for (const [key, value] of Object.entries(info)) {
        if (MAP_KEYS.includes(key.toLowerCase()) && typeof value === "string" && !found.has(materials.getTextureParams(value, {}).url)) {
          delete info[key];
        }
      }
    }
    materials.preload();
    loader.setMaterials(materials);
    colored = true;
    break;
  }
  const group = loader.parse(text);
  if (!colored) {
    group.traverse((part) => {
      if (part instanceof Mesh) part.material = new MeshStandardMaterial({ color: PLAIN });
    });
  }
  return group;
}

type GltfJson = { buffers?: { uri?: string }[]; images?: { uri?: string }[] };

/** The JSON a GLB starts with, which names any files it keeps outside itself. */
export function glbJson(bytes: ArrayBuffer): GltfJson {
  try {
    const length = new DataView(bytes).getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
  } catch {
    // Not a GLB after all, which the loader says better.
    return {};
  }
}

/**
 * Points a glTF's or GLB's outside files at copies read from beside it. One on the web, or one
 * that is missing, becomes empty, so nothing ever loads from the web. A missing picture leaves
 * its surface plain, and a missing buffer means the model can't show.
 */
async function localParts(json: GltfJson, read: ReadModel, urls: string[]) {
  const found = new Map<string, string>();
  const uris = [...(json.buffers ?? []), ...(json.images ?? [])].map((part) => part.uri);
  await Promise.all(
    uris.map(async (uri) => {
      if (!uri || uri.startsWith("data:")) return;
      const url = await partUrl(uri, read, urls);
      if (url) found.set(uri, url);
    }),
  );
  const manager = new LoadingManager();
  // Pictures packed inside the file arrive as blob: URLs of the loader's own.
  manager.setURLModifier((url) => found.get(url) ?? (/^(blob|data):/.test(url) ? url : "data:,"));
  return manager;
}
