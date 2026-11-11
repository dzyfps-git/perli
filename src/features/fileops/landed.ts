import { createSignal } from "solid-js";

/** The folders the last finished job changed, for whoever shows the drives they are on. */
export const [landed, setLanded] = createSignal<{ folders: string[] }>();
