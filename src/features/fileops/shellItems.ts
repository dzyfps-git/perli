import {
  appsFor,
  commonTags,
  fileUsers,
  itemFacts,
  openTerminal,
  openWith,
  rowFacts,
  sendTargets,
  sendTo,
  entryPicture,
  runShellItem,
  setTag,
  shellMenuItems,
  showProperties,
  showShellMenu,
  type Row,
  type Selection,
  type ShellEntry,
  type ShellTarget,
} from "../../api";
import type { MenuItem } from "../../ui/Menu";
import type { FolderView } from "../navigation/folderView";
import { refreshTags, tags } from "../tags/tags";
import type { FileActions } from "./actions";
import type { Jobs } from "./jobs";

/** Where the menu opened, in the window's own units. */
interface Point {
  x: number;
  y: number;
}

/** Keys have no pointer, so what they open goes by the window instead. */
const WINDOW_CORNER: Point = { x: 0, y: 0 };
const ZIP = ".zip";

const isZip = (name: string, isDir: boolean) => !isDir && name.toLowerCase().endsWith(ZIP);

/**
 * The parts of a right click that come from Windows. Rows are read when an item runs, so a
 * folder reloading behind an open menu can't leave it pointing at old rows.
 */
export function createShellItems(
  jobs: Jobs,
  actions: FileActions,
  /** Perli's own sheets, which the app shows. */
  sheets: { properties: (target: ShellTarget, at: Point) => void; pickApp: (paths: string[]) => void },
) {
  const report = (failure: unknown) => jobs.report(failure);

  function withRows(view: FolderView, run: (selection: Selection) => Promise<unknown>) {
    const selection = actions.selected(view);
    if (selection) run(selection).catch(report);
  }

  const physical = ({ x, y }: Point) =>
    [Math.round(x * window.devicePixelRatio), Math.round(y * window.devicePixelRatio)] as const;

  const ofFolder = (path: string): ShellTarget => ({ kind: "folder", path });

  function ofRows(view: FolderView): ShellTarget | undefined {
    const selection = actions.selected(view);
    return selection && { kind: "rows", selection };
  }

  const propertiesOf = (target: ShellTarget | undefined, at: Point) => {
    if (target) sheets.properties(target, at);
  };

  /** The paths behind the rows, which the app picker keeps while the folder reloads. */
  const pickAppFor = (view: FolderView) =>
    withRows(view, async (selection) => sheets.pickApp((await itemFacts({ kind: "rows", selection })).paths));

  const terminalItem = (path: string, divider = false): MenuItem => ({
    label: "Open in terminal",
    divider,
    action: () => openTerminal(path).catch(report),
  });

  /** Windows' whole menu, in place of this one. What Perli does better comes back to it. */
  async function showMore(view: FolderView, target: ShellTarget | undefined, at: Point, run: Record<string, () => void>) {
    if (!target) return;
    const verb = await showShellMenu(target, ...physical(at)).catch(report);
    if (verb) run[verb]?.();
  }

  /** Side menus of Windows that Perli's menu has as its own. They carry no verb to tell them by. */
  // ponytail: matched by their English label, so another language shows them twice. Match by
  // menu handler in menus.rs if that matters.
  const OWN_SIDE_MENUS = ["Open with", "Send to"];
  const isNew = (entry: ShellEntry) => !(entry.items.length > 0 && OWN_SIDE_MENUS.includes(entry.label));

  const fromWindows = (entry: ShellEntry, at: Point): MenuItem => ({
    label: entry.label,
    divider: entry.divider,
    disabled: entry.disabled,
    checked: entry.checked || undefined,
    picture: (entry.icon && entryPicture(entry.icon)) ?? undefined,
    items: entry.items.length > 0 ? entry.items.map((inner) => fromWindows(inner, at)) : undefined,
    action: entry.id === null ? undefined : () => runShellItem(entry.id!, ...physical(at)).catch(report),
  });

  /** What Windows and other apps add, in Perli's own look. Read when it opens, so it is never stale. */
  const moreItem = (target: () => ShellTarget | undefined, at: Point): MenuItem => ({
    label: "More from Windows",
    divider: true,
    async load() {
      const now = target();
      return now ? (await shellMenuItems(now)).filter(isNew).map((entry) => fromWindows(entry, at)) : [];
    },
  });

  async function whoIsUsing(selection: Selection) {
    const users = await fileUsers(selection);
    jobs.notify("What's using this?", users.length > 0 ? `Open in ${users.join(", ")}` : "No app is using this.");
  }

  return {
    /** Windows' own Properties window, for what Perli's sheet leaves to it. */
    windowsProperties: (target: ShellTarget, at: Point) => showProperties(target, ...physical(at)).catch(report),

    /** Properties for the selected rows, or the folder when none are. */
    properties(view: FolderView) {
      const path = view.folder()?.path;
      if (!view.isBin() && path) propertiesOf(ofRows(view) ?? ofFolder(path), WINDOW_CORNER);
    },

    openWithItem: (view: FolderView): MenuItem => ({
      label: "Open with",
      async load() {
        const selection = actions.selected(view);
        if (!selection) return [];
        const apps = await appsFor(selection);
        const appItems = apps.map(({ id, name }) => ({
          label: name,
          action: () => withRows(view, (rows) => openWith(rows, id)),
        }));
        // Mixed types and folders have no app in common to pick.
        if (selection.rows.length > 1 && apps.length === 0) return appItems;
        const choose = {
          label: "Choose another app…",
          divider: apps.length > 0,
          action: () => pickAppFor(view),
        };
        return [...appItems, choose];
      },
    }),

    /** `changed` runs once the rows' tags differ. `create` asks for a new tag for them. */
    tagsItem: (view: FolderView, changed: () => void, create: () => void): MenuItem => ({
      label: "Tags",
      divider: true,
      async load() {
        const selection = actions.selected(view);
        if (!selection) return [];
        await refreshTags();
        // A drive with no file IDs says so when a tag is chosen.
        const common = await commonTags({ kind: "rows", selection }).catch((): number[] => []);
        const toggle = (id: number) =>
          withRows(view, async (rows) => {
            await setTag({ kind: "rows", selection: rows }, id, !common.includes(id));
            changed();
          });
        return [
          ...tags().map(({ id, name }) => ({ label: name, checked: common.includes(id), action: () => toggle(id) })),
          { label: "New tag…", divider: tags().length > 0, action: create },
        ];
      },
    }),

    /** `row` is the row the menu opened on. Extracting only fits when all the rows are ZIPs. */
    async fileToolItems(view: FolderView, row: Row): Promise<MenuItem[]> {
      const selection = actions.selected(view);
      const facts = selection && isZip(row.name, row.isDir) ? await rowFacts(selection).catch(report) : undefined;
      const zips = !!facts?.every(([name, isDir]) => isZip(name, isDir));
      const stem = row.name.slice(0, -ZIP.length);
      return [
        { label: "Compress to ZIP", divider: true, action: () => actions.compress(view) },
        ...(zips
          ? [
              { label: "Extract here", action: () => actions.extract(view, false) },
              {
                label: facts?.length === 1 ? `Extract to ${stem}` : "Extract to own folders",
                action: () => actions.extract(view, true),
              },
            ]
          : []),
        ...(selection?.rows.length === 1 && !row.isDir
          ? [{ label: "Save as template", action: () => actions.saveTemplate(view) }]
          : []),
      ];
    },

    /** `folder` is the row's path when it is a folder. */
    rowItems(view: FolderView, at: Point, folder: string | undefined, openRow: () => void): MenuItem[] {
      const verbs = {
        open: openRow,
        explore: openRow,
        cut: () => actions.cut(view),
        copy: () => actions.copy(view),
        paste: () => actions.paste(view, folder),
        delete: () => actions.remove(view, false),
        rename: () => actions.startRename(view),
      };
      return [
        {
          label: "Send to",
          divider: true,
          load: async () =>
            (await sendTargets()).map(({ name, path, isDrive }) => ({
              label: name,
              action: () =>
                isDrive ? actions.copyTo(view, path) : withRows(view, (rows) => sendTo(rows, path)),
            })),
        },
        ...(folder ? [terminalItem(folder)] : []),
        { label: "What's using this?", action: () => withRows(view, whoIsUsing) },
        { label: "Properties", action: () => propertiesOf(ofRows(view), at) },
        moreItem(() => ofRows(view), at),
        { label: "Classic Windows menu", action: () => showMore(view, ofRows(view), at, verbs) },
      ];
    },

    backgroundItems(view: FolderView, at: Point): MenuItem[] {
      const path = view.folder()?.path;
      if (!path) return [];
      return [
        terminalItem(path, true),
        { label: "Properties", action: () => propertiesOf(ofFolder(path), at) },
        moreItem(() => ofFolder(path), at),
        {
          label: "Classic Windows menu",
          action: () => showMore(view, ofFolder(path), at, { paste: () => actions.paste(view) }),
        },
      ];
    },

    /** For a folder or drive in the sidebar. */
    placeItems: (path: string, at: Point): MenuItem[] => [
      terminalItem(path, true),
      { label: "Properties", action: () => propertiesOf(ofFolder(path), at) },
    ],
  };
}
