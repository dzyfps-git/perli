import { createSignal } from "solid-js";

/** The folders the last finished job changed, for whoever shows the drives they are on. */
export const [landed, setLanded] = createSignal<{ folders: string[] }>();

/** Drives just ejected, which slide out of the sidebar before Windows takes their letter away. */
export const [ejected, setEjected] = createSignal<string[]>([]);
