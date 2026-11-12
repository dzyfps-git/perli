/** What a picture says about itself: a colour for the backdrop, a pixel as hex, and its camera. */

/** Pixels looked at for the tint. More would only be slower. */
const SAMPLES = 4096;

/** A soft colour that stands for `pixels` (RGBA), and whether any of them is see-through. */
export function tintOf(pixels: Uint8ClampedArray): { tint: string; clear: boolean } {
  const count = pixels.length / 4;
  const stride = Math.max(1, Math.floor(count / SAMPLES));
  let red = 0;
  let green = 0;
  let blue = 0;
  let weight = 0;
  let clear = false;
  for (let at = 0; at < count; at += stride) {
    const alpha = pixels[at * 4 + 3];
    if (alpha < 250) clear = true;
    red += pixels[at * 4] * alpha;
    green += pixels[at * 4 + 1] * alpha;
    blue += pixels[at * 4 + 2] * alpha;
    weight += alpha;
  }
  if (!weight) return { tint: "transparent", clear };
  const part = (sum: number) => Math.round(sum / weight);
  return { tint: `rgb(${part(red)} ${part(green)} ${part(blue)})`, clear };
}

/** One pixel (RGBA) as `#rrggbb`. */
export function hexAt(pixel: ArrayLike<number>) {
  return "#" + [pixel[0], pixel[1], pixel[2]].map((part) => part.toString(16).padStart(2, "0")).join("");
}

/** The property names Windows uses for what a photographer wants to know, in the order shown. */
const CAMERA = ["Camera model", "Lens model", "Date taken", "F-stop", "Exposure time", "ISO speed", "Focal length"];

/** The camera facts among a file's properties, as short chips. */
export function cameraFacts(facts: [group: string, label: string, value: string][]) {
  const found = new Map(facts.map(([, label, value]) => [label, value]));
  return CAMERA.flatMap((label) => {
    const value = found.get(label)?.trim();
    if (!value) return [];
    return label === "ISO speed" && !/iso/i.test(value) ? `ISO ${value}` : value;
  });
}

/** What matters most about each kind of file, for the top of its details, in the order shown. */
const HEADLINE = ["Dimensions", "Camera model", "Length", "Contributing artists", "Album", "Bit rate", "Frame rate", "Pages", "Authors"];

/** The few facts that sum a file up: a picture's size and camera, a song's length and artist. */
export function headline(facts: [group: string, label: string, value: string][], most = 4) {
  const found = new Map(facts.map(([, label, value]) => [label, value.trim()]));
  return HEADLINE.flatMap((label) => found.get(label) || []).slice(0, most);
}
