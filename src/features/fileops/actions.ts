import {
  binSummary,
  measureSelection,
  setClipboard,
  startJob,
  undoJob,
  type Selection,
  type Task,
} from "../../api";
import type { FolderView } from "../navigation/folderView";
import { forgetCut, markCut } from "./clipboard";
import type { DeleteRequest } from "./ConfirmDelete";
import type { Jobs } from "./jobs";

/** What the keys and menus can do to files. `otherView` is the split pane, if there is one. */
export function createFileActions(
  jobs: Jobs,
  confirmDelete: (request: DeleteRequest) => void,
  otherView: () => FolderView | undefined,
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
    copy(view: FolderView) {
      const selection = movable(view);
      if (selection) setClipboard(selection, false).then(forgetCut).catch(report);
    },

    cut(view: FolderView) {
      const selection = movable(view);
      const folder = view.folder()?.path;
      if (!selection || !folder) return;
      setClipboard(selection, true)
        .then(({ names, sequence }) => markCut(folder, names, sequence))
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

    /** Rejects with the reason a name can't be used. */
    rename(view: FolderView, selection: Selection, name: string) {
      return startJob({ kind: "rename", selection, name }, view.id);
    },

    startRename(view: FolderView) {
      if (movable(view)?.rows.length === 1) view.list()?.rename();
    },

    newItem(view: FolderView, directory: boolean) {
      const folder = view.folder()?.path;
      if (folder && !view.isBin()) start(view, { kind: "new", folder, directory });
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
  };
}
