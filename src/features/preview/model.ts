/**
 * A 3D model in the quick preview: glTF, GLB, OBJ or STL, turned with the mouse. three.js is big,
 * so this file loads only when the first model opens.
 */
import {
  Box3,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

/** The model's bytes, or with `part` those of a file beside it that it points to. */
export type ReadModel = (part?: string) => Promise<ArrayBuffer>;

const FIELD_OF_VIEW = 40;
/** Room around the model when it first shows. */
const FIT_MARGIN = 1.15;
const PLAIN = 0xb8bcc4;

/** Shows the model in `canvas`. Call what it returns to let go of it. */
export async function showModel(canvas: HTMLCanvasElement, name: string, read: ReadModel): Promise<() => void> {
  const urls: string[] = [];
  const model = await load(name.split(".").pop()!.toLowerCase(), read, urls);
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(devicePixelRatio);
  const scene = new Scene();
  const environment = new PMREMGenerator(renderer);
  scene.environment = environment.fromScene(new RoomEnvironment(), 0.04).texture;
  environment.dispose();
  scene.add(model);

  const camera = new PerspectiveCamera(FIELD_OF_VIEW, 1);
  const controls = new OrbitControls(camera, canvas);
  fit(model, camera, controls);
  const draw = () => renderer.render(scene, camera);
  controls.addEventListener("change", draw);

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

  return () => {
    watcher.disconnect();
    controls.dispose();
    scene.traverse((part) => {
      if (!(part instanceof Mesh)) return;
      part.geometry.dispose();
      for (const material of [part.material].flat() as Material[]) {
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      }
    });
    scene.environment?.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    for (const url of urls) URL.revokeObjectURL(url);
  };
}

async function load(extension: string, read: ReadModel, urls: string[]): Promise<Object3D> {
  const bytes = await read();
  if (extension === "stl") {
    const geometry = new STLLoader().parse(bytes);
    geometry.computeVertexNormals();
    const colored = "hasColors" in geometry && !!geometry.hasColors;
    return new Mesh(geometry, new MeshStandardMaterial({ color: colored ? 0xffffff : PLAIN, vertexColors: colored }));
  }
  // ponytail: OBJ materials (.mtl) are left out, so every OBJ is plain grey.
  if (extension === "obj") {
    const group = new OBJLoader().parse(new TextDecoder().decode(bytes));
    group.traverse((part) => {
      if (part instanceof Mesh) part.material = new MeshStandardMaterial({ color: PLAIN });
    });
    return group;
  }
  const loader = new GLTFLoader();
  if (extension === "glb") return (await loader.parseAsync(bytes, "")).scene;
  const json = JSON.parse(new TextDecoder().decode(bytes));
  await localParts(json, read, urls);
  return (await loader.parseAsync(JSON.stringify(json), "")).scene;
}

/**
 * Points a glTF's outside files at copies read from beside it. One on the web, or one that is
 * missing, becomes empty, so nothing ever loads from the web. A missing picture leaves its
 * surface plain, and a missing buffer means the model can't show.
 */
async function localParts(json: { buffers?: { uri?: string }[]; images?: { uri?: string }[] }, read: ReadModel, urls: string[]) {
  const parts = [...(json.buffers ?? []), ...(json.images ?? [])].filter(
    (part) => part.uri !== undefined && !part.uri.startsWith("data:"),
  );
  await Promise.all(
    parts.map(async (part) => {
      const uri = part.uri!;
      let name = uri;
      try {
        name = decodeURIComponent(uri);
      } catch {
        // A stray % is part of the name.
      }
      const bytes = await read(name).catch(() => undefined);
      if (bytes) urls.push((part.uri = URL.createObjectURL(new Blob([bytes]))));
      else part.uri = "data:,";
    }),
  );
}

/** Turns about the model's middle, far enough back to see all of it. */
function fit(model: Object3D, camera: PerspectiveCamera, controls: OrbitControls) {
  const sphere = new Box3().setFromObject(model).getBoundingSphere(new Sphere());
  const radius = sphere.radius || 1;
  const distance = (radius * FIT_MARGIN) / Math.sin(((FIELD_OF_VIEW / 2) * Math.PI) / 180);
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.position.copy(sphere.center).add(new Vector3(0.6, 0.45, 1).normalize().multiplyScalar(distance));
  camera.updateProjectionMatrix();
  controls.target.copy(sphere.center);
  controls.update();
}
