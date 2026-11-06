import { createSignal, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import {
  answerJob,
  cancelJob,
  onJobEvent,
  pauseJob,
  resumeJob,
  undoJob,
  type Answer,
  type JobEvent,
  type Progress,
  type Question,
} from "../../api";
import type { FolderView } from "../navigation/folderView";
import { baseName, join, samePath } from "../navigation/path";
import { checkCut } from "./clipboard";
import { nextRate, startRate, type Rate } from "./progress";

const SHOW_AFTER_MS = 300;
const LINGER_MS = 3000;

export interface JobCard {
  id: number;
  title: string;
  /** The view that asked, which selects what the job makes. */
  origin: number | null;
  newItem: boolean;
  /** Quick jobs end before anyone could read a card, so they never show one. */
  shown: boolean;
  paused: boolean;
  question?: Question;
  progress?: Progress;
  rate: Rate;
  /** Set once the job is over. */
  ended?: {
    note: string;
    kept: string[];
    /** The undo step this job added. */
    step: number | null;
  };
}

export type Jobs = ReturnType<typeof createJobs>;
type Finished = Extract<JobEvent, { kind: "finished" }>;

/** Follows every running job, and reloads the views each one changed. */
export function createJobs(views: () => FolderView[]) {
  const [cards, setCards] = createStore<JobCard[]>([]);
  const [latestStep, setLatestStep] = createSignal<number | null>(null);
  let failures = 0;

  const find = (id: number) => cards.find((card) => card.id === id);
  const patch = (id: number, change: Partial<JobCard>) => setCards((card) => card.id === id, change);
  const remove = (id: number) => setCards((list) => list.filter((card) => card.id !== id));

  function started(id: number, title: string, origin: number | null, newItem: boolean) {
    const rate = startRate(performance.now());
    setCards(cards.length, { id, title, origin, newItem, shown: false, paused: false, rate });
    setTimeout(() => patch(id, { shown: true }), SHOW_AFTER_MS);
  }

  function reloadViews(event: Finished, card: JobCard) {
    for (const view of views()) {
      const path = view.folder()?.path;
      if (!path) continue;
      const own = view.id === card.origin;
      const made = own ? event.created.filter((item) => samePath(join(path, baseName(item)), item)) : [];
      // The list of touched folders never names the Recycle Bin.
      if (view.isBin() || made.length > 0 || event.touched.some((folder) => samePath(path, folder))) {
        view.reload(made.map(baseName), made.length > 0 && card.newItem);
      }
    }
  }

  function finished(event: Finished) {
    const card = find(event.id);
    if (!card) return;
    setLatestStep(event.latestStep);
    reloadViews(event, card);
    // A finished cut paste empties the clipboard. A cancelled one leaves the cut standing.
    checkCut().catch(console.error);

    const { kept } = event;
    if (!card.shown && kept.length === 0) return remove(event.id);
    const note = event.cancelled ? "Cancelled" : "Done";
    const ended = { note, kept, step: event.step };
    patch(event.id, { shown: true, question: undefined, ended });
    // What a move left behind stays on screen until the user has seen it.
    if (kept.length === 0) setTimeout(() => remove(event.id), LINGER_MS);
  }

  function onEvent(event: JobEvent) {
    const { id } = event;
    if (event.kind === "started") started(id, event.title, event.origin, event.newItem);
    else if (event.kind === "asked") patch(id, { question: event.question, shown: true });
    else if (event.kind === "finished") finished(event);
    else {
      const card = find(id);
      if (card) patch(id, { progress: event, rate: nextRate(card.rate, event, performance.now()) });
    }
  }

  const listener = onJobEvent(onEvent);
  onCleanup(() => listener.then((stop) => stop()));

  return {
    cards,
    latestStep,
    /** Undo reverses the newest step only, so an older job can no longer offer it. */
    canUndo: (card: JobCard) => card.ended?.step != null && card.ended.step === latestStep(),
    undo(card: JobCard) {
      remove(card.id);
      undoJob(card.origin ?? undefined, card.ended?.step ?? undefined).catch(this.report);
    },
    /** A job that never started sends no events, so its reason gets a card of its own. */
    report(failure: unknown) {
      setCards(cards.length, {
        id: --failures,
        title: String(failure),
        origin: null,
        newItem: false,
        shown: true,
        paused: false,
        rate: startRate(0),
        ended: { note: "Nothing changed", kept: [], step: null },
      });
    },
    pause(id: number) {
      patch(id, { paused: true });
      pauseJob(id).catch(console.error);
    },
    /** The paused time must not count against the speed. */
    resume(card: JobCard) {
      patch(card.id, { paused: false, rate: { ...card.rate, at: performance.now() } });
      resumeJob(card.id).catch(console.error);
    },
    cancel(id: number) {
      patch(id, { paused: false, question: undefined });
      cancelJob(id).catch(console.error);
    },
    answer(id: number, answer: Answer, all: boolean) {
      patch(id, { question: undefined });
      answerJob(id, answer, all).catch(console.error);
    },
    close: remove,
  };
}
