import {
  binSummary,
  measureSelection,
  redoJob,
  setClipboard,
  startDrag,
  startJob,
  templatesFolder,
  undoJob,
  type Selection,
  type Task,
} from "../../api";
import type { FolderView } from "../navigation/folderView";
import type { RenameRequest } from "./BatchRename";
import { forgetCut, markCut } from "./clipboard";
import type { DeleteRequest } from "./ConfirmDelete";
import type { Jobs } from "./jobs";

export type FileActions = ReturnType<typeof createFileActions>;

/** What the keys and menus can do to files. `otherView` is the split pane, if there is one. */
export function createFileActions(
  jobs: Jobs,
  confirmDelete: (request: DeleteRequest) => void,
  otherView: () => FolderView | undefined,
  askRenames: (request: RenameRequest) => void,
) {
  const report = (failure: unknown) => jobs.report(failure);
  const start = (view: FolderView, task: Task) => startJob(task, view.id).catch(report);

  function selected(view: FolderView) {
    const selection = view.list()?.selection();
    return selection?.rows.length ? selection : undefined;
  }

  /** Items in the Recycle Bin can only be restored or deleted. */
  const movable = (view: FolderView) => (view.isBin() ? undefined : selected(view));

  return {
    selected,

    copy(view: FolderView) {
      const selection = movable(view);
      if (selection) setClipboard(selection, false).then(forgetCut).catch(report);
    },

    cut(view: FolderView) {
      const selection = movable(view);
      const folder = view.folder()?.path;
      if (!selection || !folder) return;
      setClipboard(selection, true)
        // Search rows are in other folders, so their names must not fade this folder's rows.
        .then(({ names, sequence }) => markCut(folder, view.query() ? [] : names, sequence))
        .catch(report);
    },

    /** Pastes into `folder`, or else the folder on show. */
    paste(view: FolderView, folder = view.folder()?.path) {
      if (view.isBin() || !folder) return;
      start(view, { kind: "paste", folder });
    },

    toOtherPane(view: FolderView, kind: "copy" | "move") {
      const selection = movable(view);
      const folder = otherView()?.folder()?.path;
      if (selection && folder && !otherView()?.isBin()) start(view, { kind, selection, folder });
    },

    /** Copies the selection to `folder`, which needs no other pane. */
    copyTo(view: FolderView, folder: string) {
      const selection = movable(view);
      if (selection) start(view, { kind: "copy", selection, folder });
    },

    dragOut(view: FolderView) {
      const selection = movable(view);
      if (selection) startDrag(selection).catch(report);
    },

    /** Rejects with the reason a name can't be used. */
    rename(view: FolderView, selection: Selection, name: string) {
      return startJob({ kind: "rename", selection, name }, view.id);
    },

    /** One row is renamed in place, and more get the dialog. */
    startRename(view: FolderView) {
      const picked = movable(view);
      if (picked?.rows.length === 1) view.list()?.rename();
      else if (picked) {
        // Numbers go down the list, whatever order the rows were picked in.
        const selection = { ...picked, rows: [...picked.rows].sort((a, b) => a - b) };
        askRenames({ selection, confirm: (names) => start(view, { kind: "renameAll", selection, names }) });
      }
    },

    compress(view: FolderView) {
      const selection = movable(view);
      if (selection) start(view, { kind: "zip", selection });
    },

    extract(view: FolderView, ownFolder: boolean) {
      const selection = movable(view);
      if (selection) start(view, { kind: "unzip", selection, ownFolder });
    },

    saveTemplate(view: FolderView) {
      const selection = movable(view);
      if (selection) start(view, { kind: "saveTemplate", selection });
    },

    openTemplates(view: FolderView) {
      templatesFolder()
        .then((path) => view.open(path))
        .catch(report);
    },

    newItem(view: FolderView, directory: boolean) {
      const folder = view.folder()?.path;
      if (folder && !view.isBin()) start(view, { kind: "new", folder, directory });
    },

    /** A new file of a type Windows knows. */
    newFrom(view: FolderView, extension: string) {
      const folder = view.folder()?.path;
      if (folder && !view.isBin()) start(view, { kind: "template", folder, extension });
    },

    /** A new file from one the user keeps in their templates folder. */
    newFromOwn(view: FolderView, name: string) {
      const folder = view.folder()?.path;
      if (folder && !view.isBin()) start(view, { kind: "ownTemplate", folder, name });
    },

    /** The Recycle Bin is the last stop, so deleting from it always asks first. */
    remove(view: FolderView, permanently: boolean) {
      const selection = selected(view);
      if (!selection) return;
      if (!permanently && !view.isBin()) {
        start(view, { kind: "recycle", selection });
        return;
      }
      const kind = view.isBin() ? "purge" : "delete";
      confirmDelete({
        title: "Delete permanently?",
        measure: () => measureSelection(selection),
        confirm: () => start(view, { kind, selection }),
      });
    },

    restore(view: FolderView) {
      const selection = selected(view);
      if (selection) start(view, { kind: "restore", selection });
    },

    empty(view: FolderView) {
      confirmDelete({
        title: "Empty the Recycle Bin?",
        measure: binSummary,
        confirm: () => start(view, { kind: "empty" }),
      });
    },

    undo: (view: FolderView) => undoJob(view.id).catch(report),
    redo: (view: FolderView) => redoJob(view.id).catch(report),
  };
}
