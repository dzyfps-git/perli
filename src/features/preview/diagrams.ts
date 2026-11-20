import type { MermaidConfig } from "mermaid";

const ICON_ZOOM_IN = "";
const ICON_ZOOM_OUT = "";
const ICON_FIT = "";
const ICON_COPY = "";
const ICON_PICTURE = "";
const DONE_MS = 1400;
const LEAST_ZOOM = 0.25;
const MOST_ZOOM = 8;
const ZOOM_STEP = 1.25;

/** The line a Mermaid error names, counted from 1, if it names one. */
export function badLine(message: string): number | undefined {
  const found = /\bline (\d+)/i.exec(message);
  return found ? Number(found[1]) : undefined;
}

/** A color as Chromium gives it, `rgb(…)`, `rgba(…)` or `color(srgb …)`, as 0 to 255 parts. */
export function rgbOf(css: string): [number, number, number] {
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(css);
  if (srgb) return [1, 2, 3].map((at) => Math.round(Number(srgb[at]) * 255)) as [number, number, number];
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
  return rgb ? ([1, 2, 3].map((at) => Math.round(Number(rgb[at]))) as [number, number, number]) : [128, 128, 128];
}

/** `share` of `a` over `b`, as `#rrggbb`. */
export function mix(a: [number, number, number], b: [number, number, number], share: number) {
  return `#${a.map((part, at) => Math.round(part * share + b[at] * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
}

/** Perli's own colors, worked out on the page, so diagrams look like the rest of the window. */
function looks(): MermaidConfig {
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.append(probe);
  const color = (name: string) => {
    probe.style.color = `var(${name})`;
    return rgbOf(getComputedStyle(probe).color);
  };
  const [surface, text, muted, accent] = ["--surface", "--text", "--text-muted", "--accent"].map(color);
  const font = getComputedStyle(document.body).fontFamily;
  probe.remove();
  const hex = (part: [number, number, number]) => mix(part, part, 1);
  return {
    startOnLoad: false,
    // Labels stay plain SVG text: nothing in a diagram runs or links, and a copy as a picture works.
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: "base",
    fontFamily: font,
    themeVariables: {
      darkMode: document.documentElement.dataset.theme === "dark" || matchMedia("(prefers-color-scheme: dark)").matches,
      background: hex(surface),
      fontFamily: font,
      primaryColor: mix(accent, surface, 0.18),
      primaryTextColor: hex(text),
      primaryBorderColor: mix(accent, surface, 0.6),
      secondaryColor: mix(muted, surface, 0.14),
      tertiaryColor: mix(muted, surface, 0.07),
      lineColor: hex(muted),
      textColor: hex(text),
      noteBkgColor: mix(accent, surface, 0.1),
      noteTextColor: hex(text),
    },
  };
}

let loaded: Promise<typeof import("mermaid").default> | undefined;
let drawn = 0;

/** A small button like the code copy one, which says it worked. */
function tool(icon: string, label: string, run: () => unknown | Promise<unknown>) {
  const button = document.createElement("button");
  button.className = "md-diagram-tool";
  button.setAttribute("aria-label", label);
  button.textContent = icon;
  button.onclick = async () => {
    try {
      await run();
    } catch (error) {
      return console.error(error);
    }
    button.dataset.done = "";
    setTimeout(() => delete button.dataset.done, DONE_MS);
  };
  return button;
}

/** The SVG as a PNG twice its drawn size, for pasting into anything that takes pictures. */
async function picture(svg: SVGSVGElement): Promise<Blob> {
  const { width, height } = svg.viewBox.baseVal.width ? svg.viewBox.baseVal : svg.getBBox();
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * 2);
  canvas.height = Math.ceil(height * 2);
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((done, fail) => canvas.toBlob((blob) => (blob ? done(blob) : fail(new Error("No picture"))), "image/png"));
}

/** Ctrl+wheel zooms toward the pointer, a drag moves it, a double click and Fit put it back. */
function zoomable(figure: HTMLElement, svg: SVGSVGElement) {
  let zoom = 1;
  let x = 0;
  let y = 0;
  const apply = () => {
    svg.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    figure.toggleAttribute("data-zoomed", zoom !== 1 || x !== 0 || y !== 0);
  };
  /** Zooms to `next`, keeping the point `at` (from the middle of the figure) where it is. */
  const zoomTo = (next: number, at = { x: 0, y: 0 }) => {
    next = Math.min(MOST_ZOOM, Math.max(LEAST_ZOOM, next));
    x = at.x - ((at.x - x) * next) / zoom;
    y = at.y - ((at.y - y) * next) / zoom;
    zoom = next;
    apply();
  };
  const fit = () => {
    zoom = 1;
    x = y = 0;
    apply();
  };
  figure.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const box = figure.getBoundingClientRect();
      zoomTo(zoom * Math.exp(-event.deltaY / 300), { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 });
    },
    { passive: false },
  );
  figure.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    const start = { x: event.clientX - x, y: event.clientY - y };
    figure.setPointerCapture(event.pointerId);
    figure.dataset.dragging = "";
    const move = (moved: PointerEvent) => {
      x = moved.clientX - start.x;
      y = moved.clientY - start.y;
      apply();
    };
    const end = () => {
      delete figure.dataset.dragging;
      figure.removeEventListener("pointermove", move);
    };
    figure.addEventListener("pointermove", move);
    figure.addEventListener("pointerup", end, { once: true });
    figure.addEventListener("pointercancel", end, { once: true });
  });
  figure.addEventListener("dblclick", fit);
  return { zoomIn: () => zoomTo(zoom * ZOOM_STEP), zoomOut: () => zoomTo(zoom / ZOOM_STEP), fit };
}

/** The source with the line the error names marked, under what went wrong. */
function failed(block: HTMLElement, text: string, error: unknown) {
  const message = String((error as Error)?.message ?? error).trim();
  const line = badLine(message);
  const note = document.createElement("p");
  note.className = "md-diagram-error";
  note.textContent = `This diagram can't be drawn${line ? `, line ${line}` : ""}: ${message.split("\n")[0]}`;
  const code = block.querySelector("code")!;
  code.replaceChildren(
    ...text.split("\n").flatMap((part, at) => {
      const shown = at + 1 === line ? Object.assign(document.createElement("mark"), { textContent: part }) : document.createTextNode(part);
      return at ? [document.createTextNode("\n"), shown] : [shown];
    }),
  );
  block.before(note);
}

/**
 * Draws each ```mermaid block in `root` in place, with tools to zoom and copy. Mermaid loads only
 * when a page has one. A block that can't be drawn stays as code under what went wrong.
 */
// ponytail: drawn once with the theme of the moment; a theme change shows on the next open.
export async function drawDiagrams(root: HTMLElement) {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre:has(> code.language-mermaid)")];
  if (!blocks.length) return;
  loaded ??= import("mermaid").then((module) => module.default);
  const mermaid = await loaded;
  mermaid.initialize(looks());
  // One at a time: Mermaid draws in a shared scratch place.
  for (const block of blocks) {
    if (!block.isConnected) return;
    const text = block.querySelector("code")!.textContent ?? "";
    const id = `perli-diagram-${++drawn}`;
    // What a failed draw leaves in the scratch place. The drawing keeps the same id, so this runs
    // before it goes into the page.
    const scrap = () => {
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    };
    try {
      await mermaid.parse(text);
      const { svg } = await mermaid.render(id, text);
      scrap();
      const figure = document.createElement("figure");
      figure.className = "md-diagram";
      figure.innerHTML = svg;
      const drawing = figure.querySelector("svg")!;
      drawing.removeAttribute("height");
      drawing.setAttribute("role", "img");
      drawing.setAttribute("aria-label", "Diagram");
      const zoom = zoomable(figure, drawing);
      const tools = document.createElement("div");
      tools.className = "md-diagram-tools";
      tools.append(
        tool(ICON_ZOOM_IN, "Zoom in", zoom.zoomIn),
        tool(ICON_ZOOM_OUT, "Zoom out", zoom.zoomOut),
        tool(ICON_FIT, "Fit", zoom.fit),
        tool(ICON_COPY, "Copy as SVG", () => navigator.clipboard.writeText(svg)),
        tool(ICON_PICTURE, "Copy as picture", async () =>
          navigator.clipboard.write([new ClipboardItem({ "image/png": await picture(drawing) })]),
        ),
      );
      figure.append(tools);
      block.replaceWith(figure);
    } catch (error) {
      scrap();
      failed(block, text, error);
    }
  }
}
