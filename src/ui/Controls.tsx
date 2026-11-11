import { createSignal, For, Show, type JSX } from "solid-js";
import { hexToHsv, hsvToHex, parseHex, type Hsv } from "./color";
import { monthAfter, monthGrid, parseDay, toDay } from "./dates";
import "./controls.css";

/** Perli's own form controls. Checkboxes, sliders and dropdowns get their look from controls.css
 *  alone, so they need nothing from here. */

const ICON_LESS = "";
const ICON_MORE = "";
const ICON_BEFORE = "";
const ICON_AFTER = "";
const ICON_CALENDAR = "";

/** A setting that is on or off: its name, a line about it, and a switch. */
export function Switch(props: {
  label: string;
  note?: JSX.Element;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      class="switch-row"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="switch-text">
        <span class="switch-label">{props.label}</span>
        <Show when={props.note}>
          <span class="switch-note">{props.note}</span>
        </Show>
      </span>
      <span class="switch" aria-hidden="true" />
    </button>
  );
}

/** A whole number, with a button on each side to step it. */
export function NumberField(props: { value: number; least: number; most?: number; onChange: (value: number) => void }) {
  const fits = (value: number) => Number.isInteger(value) && value >= props.least && value <= (props.most ?? Infinity);
  const step = (by: number) => fits(props.value + by) && props.onChange(props.value + by);
  return (
    <span class="number-field">
      <button type="button" class="field-step" aria-label="One less" disabled={!fits(props.value - 1)} onClick={() => step(-1)}>
        {ICON_LESS}
      </button>
      <input
        type="number"
        min={props.least}
        max={props.most}
        value={props.value}
        onInput={(event) => fits(event.currentTarget.valueAsNumber) && props.onChange(event.currentTarget.valueAsNumber)}
      />
      <button type="button" class="field-step" aria-label="One more" disabled={!fits(props.value + 1)} onClick={() => step(1)}>
        {ICON_MORE}
      </button>
    </span>
  );
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const monthName = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

/**
 * A day as `yyyy-mm-dd` text, typed or picked from a small calendar. An empty box means no day.
 * The calendar is a popover, so it shows above the dialog it is in and closes on a click outside.
 */
export function DateField(props: { value: string; label: string; onChange: (value: string) => void }) {
  const today = new Date();
  const [shown, setShown] = createSignal({ year: today.getFullYear(), month: today.getMonth() });
  let field!: HTMLSpanElement;
  let calendar!: HTMLDivElement;

  function open() {
    const picked = parseDay(props.value);
    setShown(picked ?? { year: today.getFullYear(), month: today.getMonth() });
    calendar.showPopover();
    const { left, bottom } = field.getBoundingClientRect();
    const { width, height } = calendar.getBoundingClientRect();
    calendar.style.left = `${Math.max(4, Math.min(left, innerWidth - width - 4))}px`;
    calendar.style.top = `${bottom + 4 + height > innerHeight ? Math.max(4, bottom - 32 - height) : bottom + 4}px`;
  }

  function pick(value: string) {
    props.onChange(value);
    calendar.hidePopover();
  }

  const isPicked = (day: number) => props.value === toDay(shown().year, shown().month, day);
  const isToday = (day: number) =>
    toDay(shown().year, shown().month, day) === toDay(today.getFullYear(), today.getMonth(), today.getDate());

  return (
    <span ref={field} class="date-field">
      <input
        spellcheck={false}
        placeholder="yyyy-mm-dd"
        aria-label={props.label}
        aria-invalid={props.value !== "" && !parseDay(props.value)}
        value={props.value}
        onInput={(event) => props.onChange(event.currentTarget.value)}
      />
      <button type="button" class="field-step" aria-label="Pick a day" onClick={open}>
        {ICON_CALENDAR}
      </button>
      <div ref={calendar} class="calendar" popover="auto" role="dialog" aria-label={props.label}>
        <div class="calendar-head">
          <button type="button" class="field-step" aria-label="Month before" onClick={() => setShown(monthAfter(shown().year, shown().month, -1))}>
            {ICON_BEFORE}
          </button>
          <span class="calendar-month">{monthName.format(new Date(shown().year, shown().month, 1))}</span>
          <button type="button" class="field-step" aria-label="Month after" onClick={() => setShown(monthAfter(shown().year, shown().month, 1))}>
            {ICON_AFTER}
          </button>
        </div>
        <div class="calendar-days">
          <For each={WEEKDAYS}>{(name) => <span class="calendar-weekday">{name}</span>}</For>
          <For each={monthGrid(shown().year, shown().month).flat()}>
            {(day) =>
              day ? (
                <button
                  type="button"
                  class="calendar-day"
                  aria-pressed={isPicked(day)}
                  aria-current={isToday(day) ? "date" : undefined}
                  onClick={() => pick(toDay(shown().year, shown().month, day))}
                >
                  {day}
                </button>
              ) : (
                <span />
              )
            }
          </For>
        </div>
        <div class="calendar-foot">
          <button type="button" class="calendar-quick" onClick={() => pick(toDay(today.getFullYear(), today.getMonth(), today.getDate()))}>
            Today
          </button>
          <button type="button" class="calendar-quick" disabled={!props.value} onClick={() => pick("")}>
            Clear
          </button>
        </div>
      </div>
    </span>
  );
}

const ICON_DROPPER = "";
const HUE_STEP = 1;
const SHADE_STEP = 0.02;

/** Chromium's screen color picker, which TypeScript's DOM types don't know yet. */
type EyeDropperWindow = Window & { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } };

/**
 * A color as `#rrggbb`, shown as a swatch that opens Perli's own picker: a square for how strong
 * and how bright, a strip for the hue, and a box for the hex. It can also take a color from
 * anywhere on screen. The picker is a popover, so it shows above the dialog it is in.
 */
export function ColorField(props: { value: string; label: string; onChange: (value: string) => void }) {
  // Kept apart from the hex, so the hue of a gray and the strength of a black aren't lost.
  const [color, setColor] = createSignal<Hsv>(hexToHsv(props.value));
  const [typed, setTyped] = createSignal(props.value);
  let swatch!: HTMLButtonElement;
  let panel!: HTMLDivElement;
  let native!: HTMLInputElement;
  const dropper = (window as EyeDropperWindow).EyeDropper;

  function open() {
    if (panel.matches(":popover-open")) return panel.hidePopover();
    setColor(hexToHsv(props.value));
    setTyped(props.value);
    panel.showPopover();
    const { left, bottom } = swatch.getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(4, Math.min(left, innerWidth - width - 4))}px`;
    panel.style.top = `${bottom + 6 + height > innerHeight ? Math.max(4, bottom - 38 - height) : bottom + 6}px`;
  }

  function change(next: Hsv) {
    setColor(next);
    setTyped(hsvToHex(next));
    props.onChange(hsvToHex(next));
  }

  function take(hex: string | undefined) {
    if (hex) change(hexToHsv(hex));
  }

  const within = (value: number) => Math.max(0, Math.min(1, value));

  function shade(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    if (event.type === "pointerdown") event.currentTarget.setPointerCapture(event.pointerId);
    else if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = event.currentTarget.getBoundingClientRect();
    change({
      h: color().h,
      s: within((event.clientX - box.left) / box.width),
      v: within(1 - (event.clientY - box.top) / box.height),
    });
  }

  function shadeKey(event: KeyboardEvent) {
    const by = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
    if (!by) return;
    event.preventDefault();
    const { h, s, v } = color();
    change({ h, s: within(s + by[0] * SHADE_STEP), v: within(v + by[1] * SHADE_STEP) });
  }

  return (
    <>
      <button
        ref={swatch}
        type="button"
        class="color-swatch"
        aria-label={props.label}
        aria-haspopup="dialog"
        style={{ "--color": props.value }}
        onClick={open}
      />
      <div ref={panel} class="color-panel" popover="auto" role="dialog" aria-label={props.label}>
        <div
          class="color-shade"
          role="slider"
          tabindex="0"
          aria-label="Strength and brightness"
          aria-valuetext={`${Math.round(color().s * 100)}% strong, ${Math.round(color().v * 100)}% bright`}
          style={{ "--hue": color().h, "--x": `${color().s * 100}%`, "--y": `${(1 - color().v) * 100}%`, "--color": typed() }}
          onPointerDown={shade}
          onPointerMove={shade}
          onKeyDown={shadeKey}
        />
        <input
          class="color-hue"
          type="range"
          min="0"
          max="359"
          step={HUE_STEP}
          aria-label="Hue"
          value={color().h}
          onInput={(event) => change({ ...color(), h: event.currentTarget.valueAsNumber })}
        />
        <div class="color-row">
          <input
            class="color-hex"
            spellcheck={false}
            maxLength={7}
            aria-label="Hex color"
            aria-invalid={!parseHex(typed())}
            value={typed()}
            onInput={(event) => {
              setTyped(event.currentTarget.value);
              const hex = parseHex(event.currentTarget.value);
              if (!hex) return;
              setColor(hexToHsv(hex));
              props.onChange(hex);
            }}
          />
          <Show when={dropper}>
            <button
              type="button"
              class="field-step"
              aria-label="Pick from the screen"
              onClick={() =>
                new dropper!()
                  .open()
                  .then((picked) => take(parseHex(picked.sRGBHex)))
                  // Escape backs out of it, which is no failure.
                  .catch(() => undefined)
              }
            >
              {ICON_DROPPER}
            </button>
          </Show>
        </div>
        <button type="button" class="calendar-quick" onClick={() => native.click()}>
          Windows color picker
        </button>
        <input
          ref={native}
          class="color-native"
          type="color"
          tabindex="-1"
          aria-hidden="true"
          value={props.value}
          onInput={(event) => take(parseHex(event.currentTarget.value))}
        />
      </div>
    </>
  );
}

/** One setting a tool strip's cog shows. */
export interface CogItem {
  label: string;
  checked: () => boolean;
  toggle: () => void;
}

const ICON_COG = "";

/** The cog at the end of a tool strip: that feature's own few settings, right where it is used. */
export function ToolCog(props: { label: string; items: CogItem[] }) {
  let button!: HTMLButtonElement;
  let panel!: HTMLDivElement;

  function toggle() {
    if (panel.matches(":popover-open")) return panel.hidePopover();
    panel.showPopover();
    const { right, bottom } = button.getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(4, right - width)}px`;
    panel.style.top = `${bottom + 6 + height > innerHeight ? Math.max(4, bottom - 34 - height) : bottom + 6}px`;
  }

  return (
    <>
      <button ref={button} class="strip-icon" aria-label={props.label} aria-haspopup="dialog" onClick={toggle}>
        {ICON_COG}
      </button>
      <div
        ref={panel}
        class="cog-panel"
        popover="auto"
        role="dialog"
        aria-label={props.label}
        // A click here must not reach the viewer under it, which would turn its page.
        onClick={(event) => event.stopPropagation()}
      >
        <For each={props.items}>
          {(item) => <Switch label={item.label} checked={item.checked()} onChange={item.toggle} />}
        </For>
        <p class="cog-note">Also under Viewers in Settings.</p>
      </div>
    </>
  );
}
