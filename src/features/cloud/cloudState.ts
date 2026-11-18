import { createSignal } from "solid-js";
import { cloudPlaces, type CloudPlace } from "../../api";
import { placeName } from "./cloud";

/** Perli's own cloud places, as the sidebar and menus know them. */
const [places, setPlaces] = createSignal<CloudPlace[]>([]);
export const cloudPlaceList = places;
export const readCloudPlaces = () => cloudPlaces().then(setPlaces).catch(console.error);

export function placeOf(path: string) {
  const name = placeName(path)?.toLowerCase();
  return name === undefined ? undefined : places().find((place) => place.name.toLowerCase() === name);
}

/** S3 storage keeps no bin, so a delete there is for good. */
export const keepsNoBin = (path: string) => placeOf(path)?.kind === "s3";

/** Whether the Add place sheet is open. */
const [adding, setAdding] = createSignal(false);
export { adding as addingPlace, setAdding as setAddingPlace };
