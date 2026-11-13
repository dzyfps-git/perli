import { createSignal, For, Show, type JSX } from "solid-js";
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
        // Nor a key: Space on a switch would close the viewer, Enter would open the file.
        onKeyDown={(event) => event.stopPropagation()}
      >
        <For each={props.items}>
          {(item) => <Switch label={item.label} checked={item.checked()} onChange={item.toggle} />}
        </For>
        <p class="cog-note">Also under Viewers in Settings.</p>
      </div>
    </>
  );
}
