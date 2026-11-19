/** Where a finished job took things from and put them, for Space to draw as a pulse of light. */
export interface Pulse {
  /** The folders its sources were in. */
  from: string[];
  /** The folder it filled, or nothing when things only went away, as to the Recycle Bin. */
  to: string | null;
  /** Things went to the Recycle Bin or were deleted. */
  away: boolean;
}

const hearers = new Set<(pulse: Pulse) => void>();

export function notePulse(pulse: Pulse) {
  for (const hear of hearers) hear(pulse);
}

/** Hears every pulse from now on. Answers how to stop. */
export function onPulse(hear: (pulse: Pulse) => void) {
  hearers.add(hear);
  return () => void hearers.delete(hear);
}
