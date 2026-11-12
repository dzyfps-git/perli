import { createResource, For, onMount, Show } from "solid-js";
import { activity, type Activity } from "../../api";
import { ago } from "../../ui/dates";
import { openSheet } from "../../ui/sheet";
import { dayOf } from "./lists";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "./reach.css";

/**
 * What Perli did lately, newest first, read from the undo log. A step shows where its file is
 * now, and the newest one can be undone from here.
 */
export function ActivityLog(props: {
  canRedo: () => boolean;
  onShow: (path: string) => void;
  /** Undoes the step with this id, which is the newest, or with `back` every step down to it. */
  onUndo: (step: number, back: boolean) => Promise<unknown>;
  onRedo: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [steps, { refetch }] = createResource(activity);
  let dialog!: HTMLDialogElement;
  let close!: ReturnType<typeof openSheet>;
  const now = Date.now();

  /** Each day's steps under one heading. */
  const days = () => {
    const found: { day: string; steps: Activity[] }[] = [];
    for (const step of steps() ?? []) {
      const day = dayOf(step.at, now);
      if (found.at(-1)?.day === day) found.at(-1)!.steps.push(step);
      else found.push({ day, steps: [step] });
    }
    return found;
  };

  const newer = (step: Activity) => (steps() ?? []).findIndex((other) => other.id === step.id);

  // The log changes when the job ends, a moment after it was asked for.
  const change = (ask: Promise<unknown>) => ask.then(() => setTimeout(refetch, 250)).catch(() => undefined);

  onMount(() => {
    close = openSheet(dialog);
  });

  return (
    <dialog ref={dialog} class="settings confirm activity" aria-label="Activity log" onClose={props.onClose}>
      <h2>Activity</h2>
      <p class="settings-note">What can still be undone, newest first. Undo back to any step to take it and every newer one back.</p>
      <div class="activity-list">
        <For each={days()} fallback={<p class="activity-empty">{steps.loading ? "" : "Nothing to undo yet."}</p>}>
          {(group) => (
            <section>
              <h3>{group.day}</h3>
              <ul>
                <For each={group.steps}>
                  {(step) => (
                    <li class="activity-step" data-newest={step.newest ? "" : undefined}>
                      <button class="activity-what" aria-label={`Show where: ${step.text}`} onClick={() => close(() => props.onShow(step.path))}>
                        <span class="activity-text">{step.text}</span>
                        <span class="activity-when">{step.at > 0 ? ago(step.at, now) : ""}</span>
                      </button>
                      <Show
                        when={step.newest}
                        fallback={
                          <button
                            class="job-choice activity-back"
                            aria-label={`Undo this and the ${newer(step)} newer ${newer(step) === 1 ? "step" : "steps"}`}
                            onClick={() => change(props.onUndo(step.id, true))}
                          >
                            Back to here
                          </button>
                        }
                      >
                        <button class="job-choice" onClick={() => change(props.onUndo(step.id, false))}>
                          Undo
                        </button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          )}
        </For>
      </div>
      <div class="confirm-buttons">
        <Show when={props.canRedo()}>
          <button class="job-choice" onClick={() => change(props.onRedo())}>
            Redo
          </button>
        </Show>
        <button class="job-choice" onClick={() => close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}
