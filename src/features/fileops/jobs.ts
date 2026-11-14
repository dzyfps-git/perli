import { createSignal, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import {
  answerJob,
  cancelJob,
  ejectDrive,
  onJobEvent,
  pauseJob,
  resumeJob,
  startJob,
  startJobNow,
  undoJob,
  undoState,
  type Answer,
  type JobEvent,
  type Progress,
  type Question,
  type Retry,
  type Undoable,
} from "../../api";
import type { FolderView } from "../navigation/folderView";
import { baseName, join, samePath } from "../navigation/path";
import { markBack, markDeleted } from "../filelist/rowMotion";
import { checkCut } from "./clipboard";
import { setLanded } from "./landed";
import { nextRate, nextThen, startRate, withSpeed, type Rate, type Then } from "./progress";

const SHOW_AFTER_MS = 300;
const LINGER_MS = 3000;
/** Long enough to notice a slip and reach for Undo. */
const UNDO_TOAST_MS = 6000;
/** How long a card takes to fold away. */
const LEAVE_MS = 280;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

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
  /** The latest speed readings, for the line under the bar. */
  speeds: number[];
  /** The folder the job fills. */
  target: string | null;
  /** What happens once it is done. */
  then: Then;
  /** The drives it waits for while another job uses them. */
  waiting?: string[];
  /** Folding away, just before it goes. */
  leaving?: boolean;
  /** Set once the job is over. */
  ended?: {
    note: string;
    /** It ran to the end, rather than being cancelled or only telling something. */
    done: boolean;
    kept: string[];
    /** What it skipped after a problem. */
    failed: Retry[];
    /** `failed` can be tried again, as after a copy or a move. */
    retries: boolean;
    /** The undo step this job added. */
    step: number | null;
  };
}

/** What the jobs ask of the rest of Perli. */
export interface JobsHost {
  /** Opens a folder where the user is looking. */
  open: (folder: string) => void;
  /** The root of a drive that can be ejected, if `path` is on one. */
  ejectRoot: (path: string) => string | undefined;
}

export type Jobs = ReturnType<typeof createJobs>;
type Finished = Extract<JobEvent, { kind: "finished" }>;

/** Follows every running job, and reloads the views each one changed. */
export function createJobs(views: () => FolderView[], host: JobsHost) {
  const [cards, setCards] = createStore<JobCard[]>([]);
  const [latestStep, setLatestStep] = createSignal<number | null>(null);
  const [canRedo, setCanRedo] = createSignal(false);
  const [undoText, setUndoText] = createSignal<string | null>(null);
  const [redoText, setRedoText] = createSignal<string | null>(null);
  /** Cards with no job behind them count down, so their ids never meet a job's. */
  let failures = 0;

  const find = (id: number) => cards.find((card) => card.id === id);
  const patch = (id: number, change: Partial<JobCard>) => setCards((card) => card.id === id, change);
  const drop = (id: number) => setCards((list) => list.filter((card) => card.id !== id));
  /** A card on screen folds away first. */
  function remove(id: number) {
    const card = find(id);
    if (!card?.shown || card.leaving || reducedMotion.matches) return drop(id);
    patch(id, { leaving: true });
    setTimeout(() => drop(id), LEAVE_MS);
  }

  function undoable(state: Undoable) {
    setLatestStep(state.latestStep);
    setCanRedo(state.redo);
    setUndoText(state.undoText);
    setRedoText(state.redoText);
  }

  function started(event: Extract<JobEvent, { kind: "started" }>) {
    const { id, title, origin, newItem, recycle, back, target } = event;
    const rate = startRate(performance.now());
    setCards(cards.length, { id, title, origin, newItem, recycle, shown: false, paused: false, rate, speeds: [], target, then: "none" });
    if (recycle) markDeleted();
    if (back) markBack();
    setTimeout(() => patch(id, { shown: true }), SHOW_AFTER_MS);
  }

  function reloadViews(event: Finished, card: JobCard) {
    for (const view of views()) {
      const path = view.folder()?.path;
      if (!path) continue;
      const own = view.id === card.origin;
      // A row is selected by its name, or by its full path when it sits in a folder opened in place.
      const inPlace = (item: string) => view.expanded().some((open) => samePath(join(open, baseName(item)), item));
      const made = own
        ? event.created.flatMap((item) =>
            samePath(join(path, baseName(item)), item) ? [baseName(item)] : inPlace(item) ? [item] : [],
          )
        : [];
      // The list of touched folders never names the Recycle Bin, and a search reaches further.
      const anywhere = view.isBin() || !!view.query();
      // A folder opened in place shows its rows here too.
      const shows = (folder: string) => samePath(path, folder) || view.expanded().some((open) => samePath(open, folder));
      if (anywhere || made.length > 0 || event.touched.some(shows)) {
        view.reload(made, made.length > 0 && card.newItem);
      }
    }
  }

  function finished(event: Finished) {
    const card = find(event.id);
    if (!card) return;
    undoable(event);
    reloadViews(event, card);
    if (!event.cancelled && event.touched.length > 0) setLanded({ folders: event.touched });
    // A finished cut paste empties the clipboard. A cancelled one leaves the cut standing.
    checkCut().catch(console.error);

    const { kept, failed } = event;
    if (!event.cancelled) whenDone(card);
    // A delete asks nothing, so even a quick one leaves a way back.
    const toast = card.recycle && event.step !== null;
    const stays = kept.length > 0 || failed.length > 0;
    if (!card.shown && !stays && !toast) return drop(event.id);
    // Only the newest delete keeps its card, so pressing Delete again and again stacks nothing.
    if (toast) setCards((list) => list.filter((other) => !(other.recycle && other.ended)));
    const done = toast ? "In the Recycle Bin" : "Done";
    const ended = { note: event.cancelled ? "Cancelled" : done, done: !event.cancelled, kept, failed, retries: event.retries, step: event.step };
    patch(event.id, { shown: true, question: undefined, waiting: undefined, ended });
    // What a move left behind, or what it skipped, stays on screen until the user has seen it.
    if (!stays) setTimeout(() => remove(event.id), toast ? UNDO_TOAST_MS : LINGER_MS);
  }

  function whenDone(card: JobCard) {
    const target = card.target;
    if (!target || card.then === "none") return;
    if (card.then === "open") return host.open(target);
    const root = host.ejectRoot(target);
    if (root) ejectDrive(root).catch((failure) => notify(String(failure), "The drive is still in use"));
  }

  function onEvent(event: JobEvent) {
    const { id } = event;
    if (event.kind === "started") started(event);
    else if (event.kind === "asked") patch(id, { question: event.question, shown: true });
    else if (event.kind === "finished") finished(event);
    // A job held up for its drive shows at once, so the wait is never a mystery.
    else if (event.kind === "waiting") patch(id, event.drives.length > 0 ? { waiting: event.drives, shown: true } : { waiting: undefined });
    else {
      const card = find(id);
      if (!card) return;
      const rate = nextRate(card.rate, event, performance.now());
      const speeds = rate === card.rate ? card.speeds : withSpeed(card.speeds, rate.speed);
      patch(id, { progress: event, rate, speeds });
    }
  }

  /** A card with no job behind it, which only tells the user something. A `brief` one folds away by itself. */
  function notify(title: string, note: string, brief = false) {
    const id = --failures;
    if (brief) setTimeout(() => remove(id), LINGER_MS);
    setCards(cards.length, {
      id,
      title,
      origin: null,
      newItem: false,
      recycle: false,
      shown: true,
      paused: false,
      rate: startRate(0),
      speeds: [],
      target: null,
      then: "none",
      ended: { note, done: false, kept: [], failed: [], retries: false, step: null },
    });
  }

  const listener = onJobEvent(onEvent);
  onCleanup(() => listener.then((stop) => stop()));
  // The undo log outlives the app, so Undo can work before any job runs. Every window shares
  // it, so a window coming back to the front picks up what the others did meanwhile.
  const refresh = () => undoState().then(undoable).catch(console.error);
  refresh();
  window.addEventListener("focus", refresh);
  onCleanup(() => window.removeEventListener("focus", refresh));

  return {
    cards,
    latestStep,
    canRedo,
    refresh,
    /** What Undo and Redo would do now, for their hover text and menu labels. */
    undoText,
    redoText,
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
    /** The drive this card's target is on, if it can be ejected. */
    ejectRoot: (card: JobCard) => (card.target ? host.ejectRoot(card.target) : undefined),
    cycleThen(card: JobCard) {
      patch(card.id, { then: nextThen(card.then, !!card.target && !!host.ejectRoot(card.target)) });
    },
    startNow(id: number) {
      patch(id, { waiting: undefined });
      startJobNow(id).catch(console.error);
    },
    /** One job for each folder the skipped items were going to. */
    retry(card: JobCard) {
      const failed = card.ended?.failed ?? [];
      remove(card.id);
      const groups = new Map<string, Retry[]>();
      for (const item of failed) {
        const key = `${item.moving}|${item.folder.toLowerCase()}`;
        groups.set(key, [...(groups.get(key) ?? []), item]);
      }
      for (const items of groups.values()) {
        const { folder, moving } = items[0];
        const paths = items.map((item) => item.source);
        startJob({ kind: moving ? "movePaths" : "copyPaths", paths, folder }, card.origin ?? undefined).catch(this.report);
      }
    },
    close: remove,
  };
}
