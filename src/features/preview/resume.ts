/** Only a film or song this long keeps its place. */
export const RESUME_FROM_SECONDS = 10 * 60;
/** A place this near either end isn't kept: it starts over. */
export const RESUME_MARGIN_SECONDS = 30;

/** Where a film or song of this length picks up, from the place it was left: 0 starts over. */
export const resumePlace = (at: number | undefined, duration: number) =>
  at !== undefined && duration > RESUME_FROM_SECONDS && at > RESUME_MARGIN_SECONDS && at < duration - RESUME_MARGIN_SECONDS ? at : 0;
