import type { PDFDocumentProxy } from "pdfjs-dist";
import sandboxUrl from "pdfjs-dist/build/pdf.sandbox.min.mjs?url";

/**
 * A PDF's own scripts, such as a total that adds itself up or a date put in its format. They run
 * in pdf.js's sandbox, a JavaScript engine built as WebAssembly that sees only the form: no
 * files, no web, no window. Perli hosts it here in place of pdf.js's viewer, which it doesn't use.
 */

/** What the scripts may do to the view they run in. */
export interface ScriptView {
  /** Where this PDF's fields are drawn, so a change lands on its own. */
  box: () => HTMLElement;
  /** Shows the page, counted from 0. */
  go: (page: number) => void;
  count: () => number;
  current: () => number;
  /** Something the form says, such as why a value doesn't fit. */
  say: (text: string) => void;
  name: string;
}

type Fields = Map<string, { id: string; actions?: Record<string, unknown> | null }[]>;

/** What a PDF gives its scripts to start with. */
export interface Found {
  objects: Fields | null;
  order: string[] | null;
  actions: Map<unknown, unknown> | null;
}

interface Sandbox {
  create(data: unknown): void;
  dispatchEvent(event: unknown): void;
  nukeSandbox(): void;
}

/** A PDF's scripts while they run. */
export interface Scripts {
  view: ScriptView;
  send(event: unknown): void;
  update(detail: Record<string, unknown>): void;
  pageOpen(page: number): Promise<void>;
  pageClose(page: number): void;
  willSave(): Promise<void>;
  didSave(): void;
  stop(): void;
}

/** Whether the PDF has scripts of its own: on the document, on a field, or an order of totals. */
export function hasScripts({ objects, order, actions }: Found) {
  if (actions?.size || order?.length) return true;
  for (const fields of objects?.values() ?? []) {
    if (fields.some((field) => field.actions && Object.keys(field.actions).length)) return true;
  }
  return false;
}

export async function findScripts(pdf: PDFDocumentProxy): Promise<Found> {
  const [objects, order, actions] = await Promise.all([pdf.getFieldObjects() as Promise<Fields | null>, pdf.getCalculationOrderIds(), pdf.getJSActions()]);
  return { objects, order, actions };
}

const running = new Set<Scripts>();
/** The scripts a call into a sandbox is for, while it runs: what the sandbox sends then is theirs. */
let speaking: Scripts | undefined;

window.addEventListener("updatefromsandbox", (event) => {
  const detail = (event as CustomEvent).detail as Record<string, unknown>;
  // ponytail: a script's own timer calls back with no one speaking, so what it sends goes to
  // every PDF running scripts, each taking only its own fields. Two PDFs with the same field
  // ids, open at once, could then share a timed change.
  for (const scripts of speaking ? [speaking] : [...running]) scripts.update(detail);
});

/** The sandbox calls these on the window, and Perli has no plain browser dialogs. */
function answerForms() {
  const say = (text: string) => (speaking ?? [...running].at(-1))?.view.say(text);
  window.alert = (text?: unknown) => void say(String(text ?? ""));
  // ponytail: the sandbox wants an answer at once, and Perli's own dialogs answer later, so a
  // form's question is shown and answered no. A modal answer would need pdf.js to wait for one.
  window.confirm = (text?: string) => (say(`${text ?? ""}\nThe form asked this, and a preview answers no.`), false);
  window.prompt = (text?: string) => (say(`${text ?? ""}\nThe form asked this, and a preview leaves it empty.`), null);
}

/** Starts the PDF's scripts, or gives undefined when it has none. */
export async function runScripts(pdf: PDFDocumentProxy, found: Found, view: ScriptView, wasm: string): Promise<Scripts | undefined> {
  if (!hasScripts(found)) return undefined;
  const ids = new Set([...(found.objects?.values() ?? [])].flat().map((field) => field.id));
  const { QuickJSSandbox } = (await import(/* @vite-ignore */ sandboxUrl)) as { QuickJSSandbox: (wasm: string) => Promise<Sandbox> };
  const sandbox = await QuickJSSandbox(new URL(wasm, location.href).href);
  const [{ info, metadata }, { length }] = await Promise.all([pdf.getMetadata(), pdf.getDownloadInfo()]);
  const visited = new Set<number>();
  const waiting = new Map<string, () => void>();
  let stopped = false;
  answerForms();

  /** Calls into the sandbox with these scripts speaking. */
  function call(work: () => void) {
    speaking = scripts;
    try {
      work();
    } finally {
      speaking = undefined;
    }
  }

  const scripts: Scripts = {
    view,
    /** An event from a field, such as a key typed or a value left. Later, so one never runs inside another. */
    send(event: unknown) {
      setTimeout(() => !stopped && call(() => sandbox.dispatchEvent(event)), 0);
    },
    /** What the scripts send back: a field's new value, look or focus, or a step for the view. */
    update({ id, siblings, command, value, ...detail }: Record<string, unknown>) {
      if (stopped) return;
      if (!id) {
        const page = { FirstPage: 0, LastPage: view.count() - 1, NextPage: view.current() + 1, PrevPage: view.current() - 1 }[command as string];
        if (command === "page-num" && typeof value === "number") view.go(value);
        else if (page !== undefined) view.go(page);
        else if (command === "error") console.error(value);
        else if (command === "println") console.log(value);
        else if (typeof command === "string") waiting.get(command)?.();
        // Printing, saving, zooming and laying out are left to the view's own buttons.
        return;
      }
      for (const one of [id, ...((siblings as string[] | undefined) ?? [])] as string[]) {
        if (!ids.has(one)) continue;
        const element = view.box().querySelector(`[data-element-id="${CSS.escape(one)}"]`);
        if (element) element.dispatchEvent(new CustomEvent("updatefromsandbox", { detail }));
        else pdf.annotationStorage.setValue(one, detail);
      }
    },
    /** A page shown, counted from 1: its own scripts come with its first showing. */
    async pageOpen(page: number) {
      const actions = visited.has(page) ? null : await (await pdf.getPage(page)).getJSActions();
      visited.add(page);
      scripts.send({ id: "page", name: "PageOpen", pageNumber: page, actions });
    },
    pageClose(page: number) {
      if (visited.has(page)) scripts.send({ id: "page", name: "PageClose", pageNumber: page });
    },
    /** Lets the scripts finish what they do before a save, a second at most. */
    willSave() {
      return new Promise<void>((done) => {
        const finish = () => (clearTimeout(timer), waiting.delete("WillSaveFinished"), done());
        const timer = setTimeout(finish, 1000);
        waiting.set("WillSaveFinished", finish);
        scripts.send({ id: "doc", name: "WillSave" });
      });
    },
    didSave() {
      scripts.send({ id: "doc", name: "DidSave" });
    },
    stop() {
      if (stopped) return;
      call(() => sandbox.dispatchEvent({ id: "doc", name: "WillClose" }));
      stopped = true;
      running.delete(scripts);
      sandbox.nukeSandbox();
    },
  };

  call(() =>
    sandbox.create({
      objects: found.objects,
      calculationOrder: found.order,
      appInfo: { platform: navigator.platform, language: navigator.language },
      docInfo: {
        ...(info as object),
        baseURL: "",
        URL: "",
        filesize: length,
        filename: view.name,
        metadata: metadata?.getRaw(),
        authors: metadata?.get("dc:creator"),
        numPages: pdf.numPages,
        actions: found.actions,
      },
    }),
  );
  running.add(scripts);
  scripts.send({ id: "doc", name: "Open" });
  return scripts;
}
