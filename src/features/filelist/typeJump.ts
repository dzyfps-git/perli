export const PAUSE_MS = 1000;

export interface Jump {
  prefix: string;
  /** Where the search starts, counted from the focused row. */
  offset: number;
}

/** Turns typed keys into a search, the way Explorer does. */
export function createTypeJump(now = Date.now) {
  let typed = "";
  let last = -Infinity;

  return (key: string): Jump | undefined => {
    const time = now();
    if (time - last > PAUSE_MS) typed = "";
    if (key === " " && !typed) return undefined;

    last = time;
    typed += key.toLowerCase();
    const sameLetter = [...typed].every((letter) => letter === typed[0]);
    return sameLetter ? { prefix: typed[0], offset: 1 } : { prefix: typed, offset: 0 };
  };
}
