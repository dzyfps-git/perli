const darkScheme = matchMedia("(prefers-color-scheme: dark)");

/** Hears when the theme or the accent changes. Answers how to stop. */
export function watchTheme(hear: () => void) {
  const theme = new MutationObserver(hear);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "style"] });
  darkScheme.addEventListener("change", hear);
  return () => {
    theme.disconnect();
    darkScheme.removeEventListener("change", hear);
  };
}
