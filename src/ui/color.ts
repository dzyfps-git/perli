/** Colors as the color picker turns them: hue in degrees, saturation and value from 0 to 1. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

/** `#rrggbb` from what people type or paste: with or without `#`, three digits or six. */
export function parseHex(text: string) {
  const digits = text.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(digits)) return `#${[...digits].map((digit) => digit + digit).join("")}`;
  return /^[0-9a-f]{6}$/.test(digits) ? `#${digits}` : undefined;
}

export function hexToHsv(hex: string): Hsv {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const [most, least] = [Math.max(r, g, b), Math.min(r, g, b)];
  const spread = most - least;
  let h = 0;
  if (spread > 0) {
    if (most === r) h = ((g - b) / spread) % 6;
    else if (most === g) h = (b - r) / spread + 2;
    else h = (r - g) / spread + 4;
  }
  return { h: (h * 60 + 360) % 360, s: most === 0 ? 0 : spread / most, v: most };
}

export function hsvToHex({ h, s, v }: Hsv) {
  const part = (n: number) => {
    const k = (n + h / 60) % 6;
    const value = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${part(5)}${part(3)}${part(1)}`;
}
