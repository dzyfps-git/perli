const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

/**
 * Plays a change to the page as a View Transition: the page as it was blends into the page as it
 * is, and anything with a `view-transition-name` travels to its new place. `kind` lands on the root
 * as `data-morph` while it plays, for CSS to tell one kind of change from another.
 */
export function morph(change: () => void, kind = "change") {
  if (reducedMotion.matches || !document.startViewTransition) return change();
  const root = document.documentElement;
  root.dataset.morph = kind;
  const transition = document.startViewTransition(change);
  transition.finished.finally(() => {
    if (root.dataset.morph === kind) delete root.dataset.morph;
  });
  return transition;
}
