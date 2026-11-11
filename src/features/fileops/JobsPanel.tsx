import { createEffect, createSignal, For, on, Show } from "solid-js";
import { filetimeToMs, type Answer, type Facts, type Question } from "../../api";
import { formatSize } from "../../ui/format";
import { baseName } from "../navigation/path";
import type { JobCard, Jobs } from "./jobs";
import { formatSeconds, fraction, secondsLeft } from "./progress";
import "./fileops.css";

const ICON_PAUSE = "";
const ICON_RESUME = "";
const ICON_CLOSE = "";
const KEPT_SHOWN = 5;

const LABELS: Record<Answer, string> = {
  replace: "Replace",
  keepBoth: "Keep both",
  merge: "Merge",
  skip: "Skip",
  retry: "Retry",
  elevate: "As administrator",
  permanent: "Delete permanently",
  cancel: "Cancel",
};

const dates = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** One side of a conflict, with what makes it stand out against the other side. */
function describe(facts: Facts, other: Facts) {
  const size = facts.folder ? "Folder" : formatSize(facts.size);
  const marks = [];
  if (facts.modified > other.modified) marks.push("newer");
  if (!facts.folder && !other.folder && facts.size > other.size) marks.push("larger");
  const text = `${size}, ${dates.format(filetimeToMs(facts.modified))}`;
  return marks.length > 0 ? `${text} (${marks.join(", ")})` : text;
}

function questionText(question: Question) {
  if (question.kind === "conflict") return `${question.name} already exists here.`;
  if (question.kind === "noBin") return `${baseName(question.path)} can't go to the Recycle Bin.`;
  return `${baseName(question.path)}: ${question.message}`;
}

function factsText(card: JobCard) {
  const { progress, rate, paused } = card;
  if (!progress) return "Getting ready";
  const done =
    progress.totalBytes > 0
      ? `${formatSize(progress.bytes)} of ${formatSize(progress.totalBytes)}`
      : `${progress.items} of ${progress.totalItems} items`;
  if (paused) return `${done} · Paused`;
  const left = secondsLeft(progress, rate);
  const speed = rate.speed > 0 ? `${formatSize(Math.round(rate.speed))}/s` : undefined;
  const time = left === undefined ? undefined : `${formatSeconds(left)} left`;
  return [done, speed, time].filter(Boolean).join(" · ");
}

/** Never takes the focus, so Enter in the list can't answer a question nobody has read. */
function Prompt(props: { question: Question; onAnswer: (answer: Answer, all: boolean) => void }) {
  const [all, setAll] = createSignal(false);
  const conflict = () => (props.question.kind === "conflict" ? props.question : undefined);
  return (
    <div class="job-prompt" role="alert">
      <p class="job-question">{questionText(props.question)}</p>
      <Show when={conflict()}>
        {(open) => (
          <dl class="job-compare">
            <dt>New</dt>
            <dd>{describe(open().source, open().target)}</dd>
            <dt>Existing</dt>
            <dd>{describe(open().target, open().source)}</dd>
          </dl>
        )}
      </Show>
      <div class="job-choices">
        <For each={props.question.choices}>
          {(answer) => (
            <button class="job-choice" onClick={() => props.onAnswer(answer, all())}>
              {LABELS[answer]}
            </button>
          )}
        </For>
      </div>
      <label class="job-all">
        <input type="checkbox" checked={all()} onChange={(event) => setAll(event.currentTarget.checked)} />
        Apply to all
      </label>
    </div>
  );
}

function Card(props: { card: JobCard; jobs: Jobs }) {
  const { card, jobs } = props;
  const shownKept = () => card.ended?.kept.slice(0, KEPT_SHOWN) ?? [];
  const keptCount = () => card.ended?.kept.length ?? 0;
  return (
    <section class="job" classList={{ "job-leaving": card.leaving }} aria-label={card.title}>
      <header class="job-header">
        <span class="job-title">{card.title}</span>
        <Show
          when={!card.ended}
          fallback={
            <button class="job-icon" aria-label="Close" onClick={() => jobs.close(card.id)}>
              {ICON_CLOSE}
            </button>
          }
        >
          <Show
            when={card.paused}
            fallback={
              <button class="job-icon" aria-label="Pause" onClick={() => jobs.pause(card.id)}>
                {ICON_PAUSE}
              </button>
            }
          >
            <button class="job-icon" aria-label="Resume" onClick={() => jobs.resume(card)}>
              {ICON_RESUME}
            </button>
          </Show>
          <button class="job-icon" aria-label="Cancel" onClick={() => jobs.cancel(card.id)}>
            {ICON_CLOSE}
          </button>
        </Show>
      </header>
      <Show
        when={card.ended}
        fallback={
          <>
            <span class="job-bar" role="presentation">
              <span
                class="job-fill"
                style={{ transform: `scaleX(${card.progress ? fraction(card.progress) : 0})` }}
              />
            </span>
            <p class="job-facts">{factsText(card)}</p>
            <Show when={card.progress?.current}>
              {(current) => <p class="job-facts job-current">{baseName(current())}</p>}
            </Show>
          </>
        }
      >
        {(ended) => (
          <>
            <Show when={ended().done}>
              {/* The bar stays a moment, full and green, so a finished job reads at a glance. */}
              <span class="job-bar" role="presentation">
                <span class="job-fill job-fill-done" />
              </span>
            </Show>
            <p class="job-facts">{ended().note}</p>
            <Show when={keptCount() > 0}>
              <p class="job-facts">
                {keptCount()} changed during the move, so the originals stayed in place:
              </p>
              <ul class="job-kept">
                <For each={shownKept()}>{(path) => <li class="job-current">{baseName(path)}</li>}</For>
              </ul>
            </Show>
            <Show when={jobs.canUndo(card)}>
              <div class="job-choices">
                <button class="job-choice" onClick={() => jobs.undo(card)}>
                  Undo
                </button>
              </div>
            </Show>
          </>
        )}
      </Show>
      <Show when={card.question} keyed>
        {(question) => (
          <Prompt question={question} onAnswer={(answer, all) => jobs.answer(card.id, answer, all)} />
        )}
      </Show>
    </section>
  );
}

/**
 * All the jobs on show that are still running, as one thread along the top of the window: as long
 * as their progress taken together, dim while every one is paused, and one glow as the last ends.
 */
function JobThread(props: { cards: JobCard[] }) {
  const running = () => props.cards.filter((card) => !card.ended);
  const share = () => {
    const cards = running();
    const sum = cards.reduce((total, card) => total + (card.progress ? fraction(card.progress) : 0), 0);
    return cards.length > 0 ? sum / cards.length : 0;
  };
  const [done, setDone] = createSignal(false);
  createEffect(
    on(
      () => running().length,
      (now, before) => setDone(now === 0 && (before ?? 0) > 0),
    ),
  );
  return (
    <Show when={running().length > 0 || done()}>
      <span
        class="job-thread"
        role="presentation"
        data-paused={running().length > 0 && running().every((card) => card.paused) ? "" : undefined}
        data-done={done() ? "" : undefined}
        style={{ transform: `scaleX(${done() ? 1 : Math.max(0.02, share())})` }}
        onAnimationEnd={() => setDone(false)}
      />
    </Show>
  );
}

export function JobsPanel(props: { jobs: Jobs }) {
  const shown = () => props.jobs.cards.filter((card) => card.shown);
  return (
    <>
      <JobThread cards={shown()} />
      {/* Pressing a button here leaves the focus in the list, so the keys keep working there. */}
      <div class="jobs" aria-live="polite" onPointerDown={(event) => event.preventDefault()}>
        <For each={shown()}>{(card) => <Card card={card} jobs={props.jobs} />}</For>
      </div>
    </>
  );
}
