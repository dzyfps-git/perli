import { saved } from "../filelist/prefs";

/** Where long films and songs were left, kept for this many files. */
const MOST_RESUMES = 100;

/** A time as the players show it: `m:ss`, or `h:mm:ss` past an hour. */
export const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const rest = `${Math.floor((whole % 3600) / 60)}:${String(whole % 60).padStart(2, "0")}`;
  return hours ? `${hours}:${rest.padStart(5, "0")}` : rest;
};

export function resumes(): Record<string, number> {
  return (saved("song-resume") as Record<string, number> | null) ?? {};
}

export function remember(path: string, seconds: number | undefined) {
  const all = resumes();
  delete all[path];
  if (seconds !== undefined) all[path] = seconds;
  const kept = Object.entries(all).slice(-MOST_RESUMES);
  localStorage.setItem("perli-song-resume", JSON.stringify(Object.fromEntries(kept)));
}
