import { createEffect, For, onCleanup, onMount } from "solid-js";
import type { FolderView } from "../navigation/folderView";
import { toCrumbs } from "../navigation/path";
import "./pathbar.css";

const ICON_BACK = "";
const ICON_FORWARD = "";
const ICON_UP = "";

export function PathBar(props: { view: FolderView }) {
  const crumbs = () => toCrumbs(props.view.trail());
  const depth = () => toCrumbs(props.view.folder()?.path ?? "").length;
  let list!: HTMLOListElement;

  // Narrow panes clip the crumbs, and the current folder must stay visible.
  const revealCurrent = () => list.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest", inline: "end" });

  createEffect(() => {
    crumbs();
    depth();
    revealCurrent();
  });

  onMount(() => {
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(list);
    onCleanup(() => observer.disconnect());
  });

  return (
    <nav class="pathbar" aria-label="Folder navigation">
      <button class="nav-button" aria-label="Back" disabled={!props.view.canGoBack()} onClick={() => props.view.back()}>
        {ICON_BACK}
      </button>
      <button
        class="nav-button"
        aria-label="Forward"
        disabled={!props.view.canGoForward()}
        onClick={() => props.view.forward()}
      >
        {ICON_FORWARD}
      </button>
      <button class="nav-button" aria-label="Up" disabled={!props.view.canGoUp()} onClick={() => props.view.up()}>
        {ICON_UP}
      </button>
      <ol ref={list} class="crumbs">
        <For each={crumbs()}>
          {(crumb, index) => (
            <li>
              <button
                class="crumb"
                classList={{ "crumb-left": index() >= depth() }}
                aria-current={index() === depth() - 1 ? "location" : undefined}
                onClick={() => props.view.open(crumb.path)}
              >
                {crumb.label}
              </button>
            </li>
          )}
        </For>
      </ol>
    </nav>
  );
}
