import { createSignal, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import {
  answerJob,
  cancelJob,
  onJobEvent,
  pauseJob,
  resumeJob,
  undoJob,
  undoState,
  type Answer,
  type JobEvent,
  type Progress,
  type Question,
  type Undoable,
} from "../../api";
import type { FolderView } from "../navigation/folderView";
import { baseName, join, samePath } from "../navigation/path";
import { checkCut } from "./clipboard";
import { nextRate, startRate, type Rate } from "./progress";

const SHOW_AFTER_MS = 300;
const LINGER_MS = 3000;
/** Long enough to notice a slip and reach for Undo. */
const UNDO_TOAST_MS = 6000;

export interface JobCard {
  id: number;
  title: string;
  /** The view that asked, which selects what the job makes. */
  origin: number | null;
  newItem: boolean;
  recycle: boolean;
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
  const [canRedo, setCanRedo] = createSignal(false);
  /** Cards with no job behind them count down, so their ids never meet a job's. */
  let failures = 0;

  const find = (id: number) => cards.find((card) => card.id === id);
  const patch = (id: number, change: Partial<JobCard>) => setCards((card) => card.id === id, change);
  const remove = (id: number) => setCards((list) => list.filter((card) => card.id !== id));

  function undoable(state: Undoable) {
    setLatestStep(state.latestStep);
    setCanRedo(state.redo);
  }

  function started(event: Extract<JobEvent, { kind: "started" }>) {
    const { id, title, origin, newItem, recycle } = event;
    const rate = startRate(performance.now());
    setCards(cards.length, { id, title, origin, newItem, recycle, shown: false, paused: false, rate });
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
    undoable(event);
    reloadViews(event, card);
    // A finished cut paste empties the clipboard. A cancelled one leaves the cut standing.
    checkCut().catch(console.error);

    const { kept } = event;
    // A delete asks nothing, so even a quick one leaves a way back.
    const toast = card.recycle && event.step !== null;
    if (!card.shown && kept.length === 0 && !toast) return remove(event.id);
    // Only the newest delete keeps its card, so pressing Delete again and again stacks nothing.
    if (toast) setCards((list) => list.filter((other) => !(other.recycle && other.ended)));
    const done = toast ? "In the Recycle Bin" : "Done";
    const ended = { note: event.cancelled ? "Cancelled" : done, kept, step: event.step };
    patch(event.id, { shown: true, question: undefined, ended });
    // What a move left behind stays on screen until the user has seen it.
    if (kept.length === 0) setTimeout(() => remove(event.id), toast ? UNDO_TOAST_MS : LINGER_MS);
  }

  function onEvent(event: JobEvent) {
    const { id } = event;
    if (event.kind === "started") started(event);
    else if (event.kind === "asked") patch(id, { question: event.question, shown: true });
    else if (event.kind === "finished") finished(event);
    else {
      const card = find(id);
      if (card) patch(id, { progress: event, rate: nextRate(card.rate, event, performance.now()) });
    }
  }

  /** A card with no job behind it, which only tells the user something. */
  function notify(title: string, note: string) {
    setCards(cards.length, {
      id: --failures,
      title,
      origin: null,
      newItem: false,
      recycle: false,
      shown: true,
      paused: false,
      rate: startRate(0),
      ended: { note, kept: [], step: null },
    });
  }

  const listener = onJobEvent(onEvent);
  onCleanup(() => listener.then((stop) => stop()));
  // The undo log outlives the app, so Undo can work before any job runs.
  undoState().then(undoable).catch(console.error);

  return {
    cards,
    latestStep,
    canRedo,
    /** Undo reverses the newest step only, so an older job can no longer offer it. */
    canUndo: (card: JobCard) => card.ended?.step != null && card.ended.step === latestStep(),
    undo(card: JobCard) {
      remove(card.id);
      undoJob(card.origin ?? undefined, card.ended?.step ?? undefined).catch(this.report);
    },
    /** A job that never started sends no events, so its reason gets a card of its own. */
    report: (failure: unknown) => notify(String(failure), "Nothing changed"),
    notify,
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
