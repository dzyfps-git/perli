import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { FontFacts } from "../../api";
import { saved, stored } from "../filelist/prefs";

const SIZES = [12, 16, 24, 32, 48, 72];
const PANGRAM = "The quick brown fox jumps over the lazy dog 0123456789";
/** The characters come this many at a time as the list scrolls, since a big font has tens of thousands. */
const CHUNK = 600;
const DONE_MS = 1400;
/** The sample typed stays for the next font, and for next time. */
const [typed, setTyped] = stored("font-sample", typeof saved("font-sample") === "string" ? (saved("font-sample") as string) : "");

/** Another font chosen with this one, to set the sample in under it. */
export interface OtherFont {
  name: string;
  load: () => Promise<ArrayBuffer>;
}

export interface FontViewProps {
  faces: FontFacts[];
  load: (face: number) => Promise<ArrayBuffer>;
  /** The other fonts chosen with this one. */
  others: () => Promise<OtherFont[]>;
  note: (text: string | undefined) => void;
}

let made = 0;

const hex = (point: number) => `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
/** Code points with no picture of their own: the control characters. */
const drawable = (point: number) => point >= 0x20 && !(point >= 0x7f && point < 0xa0);

/**
 * A font: a sample to type over, at several sizes, every character it draws, sliders for a
 * variable font's axes, what the font says about itself, and the sample set in the other fonts
 * chosen with it.
 */
export function FontView(live: FontViewProps) {
  const props = { ...live };
  const added: FontFace[] = [];
  const families = new Map<number, Promise<string>>();
  const [picked, setPicked] = createSignal(0);
  const [family, setFamily] = createSignal<string>();
  const [problem, setProblem] = createSignal<string>();
  const [axes, setAxes] = createSignal<Record<string, number>>({});
  const [hovered, setHovered] = createSignal<number>();
  const [copied, setCopied] = createSignal<number>();
  const [count, setCount] = createSignal(CHUNK);
  const [others, setOthers] = createSignal<{ name: string; family: string }[]>([]);
  let gone = false;

  /** Loads a font's bytes under a name of its own for this window, and gives that name. */
  async function loadFace(bytes: ArrayBuffer) {
    const face = new FontFace(`perli-font-${++made}`, bytes);
    await face.load();
    // A load that ends after the preview has gone would stay in the window for good.
    if (!gone) {
      document.fonts.add(face);
      added.push(face);
    }
    return face.family;
  }
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let more: HTMLDivElement | undefined;

  const facts = () => props.faces[picked()];
  const sample = () => typed() || facts().sample || PANGRAM;
  const points = createMemo(() => facts().characters.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, at) => first + at)).filter(drawable));
  const variation = () =>
    Object.entries(axes())
      .map(([tag, value]) => `"${tag}" ${value}`)
      .join(", ") || undefined;
  const look = () => ({ "font-family": family() ? `"${family()}"` : undefined, "font-variation-settings": variation() });

  createEffect(
    on(picked, (face) => {
      setFamily(undefined);
      setProblem(undefined);
      setCount(CHUNK);
      setAxes(Object.fromEntries(facts().axes.map((axis) => [axis.tag, axis.default])));
      if (!families.has(face)) families.set(face, props.load(face).then(loadFace));
      families
        .get(face)!
        .then((name) => !gone && picked() === face && setFamily(name))
        .catch((reason) => !gone && setProblem(`This font can't be drawn here: ${reason instanceof Error ? reason.message : reason}`));
      const shown = facts();
      props.note([shown.fullName || shown.family, `${shown.glyphs.toLocaleString()} glyphs`, `${points().length.toLocaleString()} characters`].join(" · "));
    }),
  );

  onMount(() => {
    void props
      .others()
      .then((fonts) =>
        Promise.all(
          fonts.map((font) =>
            font
              .load()
              .then(loadFace)
              .then((name) => ({ name: font.name, family: name }))
              .catch(() => undefined),
          ),
        ),
      )
      .then((loaded) => !gone && setOthers(loaded.filter((one) => one !== undefined)));
    const watch = new IntersectionObserver((seen) => seen[0].isIntersecting && setCount(count() + CHUNK), { rootMargin: "400px" });
    createEffect(() => {
      watch.disconnect();
      if (more && count() < points().length) watch.observe(more);
    });
    onCleanup(() => watch.disconnect());
  });

  onCleanup(() => {
    gone = true;
    clearTimeout(copiedTimer);
    for (const face of added) document.fonts.delete(face);
    props.note(undefined);
  });

  function copy(point: number) {
    void navigator.clipboard.writeText(String.fromCodePoint(point)).then(() => {
      setCopied(point);
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => setCopied(undefined), DONE_MS);
    });
  }

  const pointAt = (event: Event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-point]");
    return cell ? Number(cell.dataset.point) : undefined;
  };

  const shownFacts = () => {
    const shown = facts();
    const widths = ["", "Ultra-condensed", "Extra-condensed", "Condensed", "Semi-condensed", "Normal", "Semi-expanded", "Expanded", "Extra-expanded", "Ultra-expanded"];
    return [
      ["Family", shown.family],
      ["Style", shown.style],
      ["Version", shown.version.replace(/^Version\s*/i, "")],
      ["Designer", shown.designer],
      ["Made by", shown.maker],
      ["Glyphs", shown.glyphs.toLocaleString()],
      ["Characters", points().length.toLocaleString()],
      ["Weight", String(shown.weight)],
      ["Width", widths[shown.width] ?? ""],
      ["Outlines", shown.outlines],
      ["Units per em", String(shown.unitsPerEm)],
      ["Spacing", shown.monospaced ? "Monospaced" : "Proportional"],
      ["Embedding", shown.embedding],
      ["Description", shown.description],
      ["License", shown.license],
      ["Copyright", shown.copyright],
    ].filter(([, value]) => value);
  };

  return (
    <div class="font-view">
      <Show when={props.faces.length > 1}>
        <div class="font-faces" role="tablist" aria-label="Faces">
          <For each={props.faces}>
            {(face, at) => (
              <button class="font-face-chip" role="tab" aria-selected={picked() === at()} onClick={() => setPicked(at())}>
                {face.style || face.fullName}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={problem()}>
        <p class="preview-note" role="alert">
          {problem()}
        </p>
      </Show>
      <h2 class="font-title" style={look()}>
        {facts().fullName || facts().family}
      </h2>
      <input
        class="font-sample"
        style={look()}
        aria-label="Sample text, type your own"
        value={typed()}
        placeholder={facts().sample || PANGRAM}
        spellcheck={false}
        onInput={(event) => setTyped(event.currentTarget.value)}
      />
      <Show when={facts().axes.length}>
        <div class="font-axes">
          <For each={facts().axes}>
            {(axis) => (
              <label class="font-axis">
                <span>{axis.name || axis.tag}</span>
                <input
                  type="range"
                  min={axis.min}
                  max={axis.max}
                  step={axis.max - axis.min > 20 ? 1 : 0.1}
                  value={axes()[axis.tag] ?? axis.default}
                  style={{ "--fill": ((axes()[axis.tag] ?? axis.default) - axis.min) / (axis.max - axis.min || 1) }}
                  onInput={(event) => setAxes({ ...axes(), [axis.tag]: event.currentTarget.valueAsNumber })}
                  onDblClick={() => setAxes({ ...axes(), [axis.tag]: axis.default })}
                />
                <output>{Math.round((axes()[axis.tag] ?? axis.default) * 10) / 10}</output>
              </label>
            )}
          </For>
        </div>
      </Show>
      <div class="font-sizes">
        <For each={SIZES}>
          {(size) => (
            <div class="font-size-line">
              <span class="font-size-label">{size}</span>
              <p style={{ ...look(), "font-size": `${size}px` }}>{sample()}</p>
            </div>
          )}
        </For>
      </div>
      <Show when={others().length}>
        <section class="font-section" aria-label="The other fonts chosen">
          <h3>Side by side</h3>
          <div class="font-size-line font-compare">
            <span class="font-size-label">{facts().family}</span>
            <p style={look()}>{sample()}</p>
          </div>
          <For each={others()}>
            {(other) => (
              <div class="font-size-line font-compare">
                <span class="font-size-label">{other.name}</span>
                <p style={{ "font-family": `"${other.family}"` }}>{sample()}</p>
              </div>
            )}
          </For>
        </section>
      </Show>
      <section class="font-section" aria-label="Characters">
        <h3>Characters</h3>
        <div class="font-loupe" aria-live="polite">
          <Show when={hovered() ?? copied()} fallback={<span class="font-loupe-hint">Point at one to see it big, click to copy it</span>}>
            {(point) => (
              <>
                <span class="font-loupe-glyph" style={look()}>
                  {String.fromCodePoint(point())}
                </span>
                <span class="font-loupe-code">{copied() === point() ? "Copied" : hex(point())}</span>
              </>
            )}
          </Show>
        </div>
        <div
          class="font-grid"
          style={look()}
          onPointerOver={(event) => setHovered(pointAt(event))}
          onPointerLeave={() => setHovered(undefined)}
          onClick={(event) => {
            const point = pointAt(event);
            if (point !== undefined) copy(point);
          }}
        >
          <For each={points().slice(0, count())}>{(point) => <span data-point={point}>{String.fromCodePoint(point)}</span>}</For>
        </div>
        <div ref={more} />
      </section>
      <section class="font-section" aria-label="About this font">
        <h3>About</h3>
        <dl class="font-facts">
          <For each={shownFacts()}>
            {([label, value]) => (
              <>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </>
            )}
          </For>
        </dl>
      </section>
    </div>
  );
}
