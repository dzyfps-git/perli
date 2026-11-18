import { createResource, createSignal, For, onMount, Show } from "solid-js";
import {
  addS3,
  bringBack,
  cancelSignIn,
  cloudVersions,
  filetimeToMs,
  removePlace,
  reorderPlaces,
  setCloudPdf,
  signInCloud,
  type CloudKind,
  type CloudPlace,
} from "../../api";
import { Switch } from "../../ui/Controls";
import { isoText } from "../../ui/dates";
import { formatSize } from "../../ui/format";
import { openSheet } from "../../ui/sheet";
import { KIND_LABELS, s3Missing, s3Setup, S3_PRESETS, type S3Fields } from "./cloud";
import { cloudPlaceList, readCloudPlaces, setAddingPlace } from "./cloudState";
import "../settings/settings.css";
import "../fileops/fileops.css";
import "../dialogs/dialogs.css";
import "./cloud.css";

const ICON_CLOUD = "";
const ICON_STORAGE = "";
const SIGN_INS: { kind: CloudKind; note: string }[] = [
  { kind: "oneDrive", note: "Personal, work or school" },
  { kind: "dropbox", note: "Your own or your team's" },
  { kind: "google", note: "Docs come down as Office files" },
];

/**
 * Adds a cloud place: a sign-in in the browser for OneDrive, Dropbox and Google Drive, or a key
 * for S3 storage. Keys are kept by Windows' Credential Manager, never in Perli's files.
 */
export function AddPlace(props: { onAdded: (place: CloudPlace) => void }) {
  const [step, setStep] = createSignal<"choose" | "waiting" | "s3">("choose");
  const [waitingFor, setWaitingFor] = createSignal<CloudKind>();
  const [failure, setFailure] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [presetId, setPresetId] = createSignal("aws");
  const [fields, setFields] = createSignal<S3Fields>({ value: "", endpoint: "", bucket: "", keyId: "", pathStyle: false });
  const [secret, setSecret] = createSignal("");
  const [name, setName] = createSignal("");
  let dialog!: HTMLDialogElement;
  let close!: ReturnType<typeof openSheet>;
  let cancelled = false;

  const preset = () => S3_PRESETS.find((one) => one.id === presetId())!;
  const missing = () => s3Missing(preset(), fields(), secret());
  const field = (key: keyof S3Fields) => (event: { currentTarget: HTMLInputElement }) => {
    setFields({ ...fields(), [key]: key === "pathStyle" ? event.currentTarget.checked : event.currentTarget.value });
    setFailure(undefined);
  };
  const added = (place: CloudPlace) => {
    void readCloudPlaces();
    close(() => props.onAdded(place));
  };

  async function signIn(kind: CloudKind) {
    cancelled = false;
    setFailure(undefined);
    setWaitingFor(kind);
    setStep("waiting");
    try {
      added(await signInCloud(kind));
    } catch (reason) {
      if (cancelled) return;
      setFailure(String(reason));
      setStep("choose");
    }
  }

  function stopWaiting() {
    cancelled = true;
    void cancelSignIn();
    setStep("choose");
  }

  async function addBucket() {
    if (missing() || busy()) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const setup = s3Setup(preset(), fields());
      added(await addS3(setup, secret(), name().trim() || setup.bucket));
    } catch (reason) {
      setFailure(String(reason));
    } finally {
      setBusy(false);
    }
  }

  onMount(() => {
    close = openSheet(dialog);
  });

  return (
    <dialog
      ref={dialog}
      class="settings confirm drive-sheet cloud-sheet"
      aria-label="Add a cloud place"
      onClose={() => {
        if (step() === "waiting") void cancelSignIn();
        setAddingPlace(false);
      }}
      onKeyDown={(event) => event.key === "Enter" && step() === "s3" && (event.target as HTMLElement).tagName === "INPUT" && addBucket()}
    >
      <h2>Add a cloud place</h2>
      <Show when={step() === "choose"}>
        <p class="settings-note">It opens as a folder of its own, under Cloud in the sidebar.</p>
        <div class="cloud-kinds">
          <For each={SIGN_INS}>
            {(each) => (
              <button class="cloud-kind" onClick={() => signIn(each.kind)}>
                <span class="cloud-kind-icon" aria-hidden="true">
                  {ICON_CLOUD}
                </span>
                <span class="cloud-kind-name">{KIND_LABELS[each.kind]}</span>
                <span class="cloud-kind-note">{each.note}</span>
              </button>
            )}
          </For>
          <button class="cloud-kind" onClick={() => setStep("s3")}>
            <span class="cloud-kind-icon" aria-hidden="true">
              {ICON_STORAGE}
            </span>
            <span class="cloud-kind-name">S3 storage</span>
            <span class="cloud-kind-note">Amazon, R2, B2, Wasabi, MinIO</span>
          </button>
        </div>
      </Show>
      <Show when={step() === "waiting"}>
        <div class="cloud-waiting" role="status">
          <span class="cloud-spinner" aria-hidden="true" />
          <p>
            Finish signing in to {KIND_LABELS[waitingFor()!]} in your browser. Perli waits here and goes on by
            itself.
          </p>
        </div>
      </Show>
      <Show when={step() === "s3"}>
        <div class="drive-fields">
          <label class="rename-field">
            Service
            <select value={presetId()} onChange={(event) => setPresetId(event.currentTarget.value)}>
              <For each={S3_PRESETS}>{(one) => <option value={one.id}>{one.label}</option>}</For>
            </select>
          </label>
          <Show when={!preset().endpoint}>
            <label class="rename-field">
              Address
              <input spellcheck={false} placeholder="http://localhost:9000" value={fields().endpoint} onInput={field("endpoint")} />
            </label>
          </Show>
          <label class="rename-field">
            {preset().asks ?? "Region"}
            <input spellcheck={false} placeholder={preset().asks ? "" : preset().region} value={fields().value} onInput={field("value")} />
          </label>
          <label class="rename-field">
            Bucket
            <input spellcheck={false} value={fields().bucket} onInput={field("bucket")} />
          </label>
          <label class="rename-field">
            Access key
            <input spellcheck={false} autocomplete="off" value={fields().keyId} onInput={field("keyId")} />
          </label>
          <label class="rename-field">
            Secret
            <input type="password" autocomplete="off" value={secret()} onInput={(event) => setSecret(event.currentTarget.value)} />
          </label>
          <label class="rename-field">
            Name
            <input spellcheck={false} placeholder={fields().bucket.trim() || "As the bucket"} value={name()} onInput={(event) => setName(event.currentTarget.value)} />
          </label>
        </div>
        <Show when={preset().id === "custom"}>
          <Switch
            label="Bucket in the path"
            note="For storage that wants the bucket after the address, not before it"
            checked={fields().pathStyle}
            onChange={(on) => setFields({ ...fields(), pathStyle: on })}
          />
        </Show>
      </Show>
      <p class="drive-hint" classList={{ "properties-failure": !!failure() }} role="status">
        {failure() ?? (step() === "s3" ? (missing() ?? "Perli looks at the bucket once before adding it.") : "")}
      </p>
      <div class="confirm-buttons properties-buttons">
        <Show when={step() !== "choose"}>
          <button class="properties-link" onClick={() => (step() === "waiting" ? stopWaiting() : setStep("choose"))}>
            Back
          </button>
        </Show>
        <span class="properties-said" />
        <button class="job-choice" onClick={() => close()}>
          Cancel
        </button>
        <Show when={step() === "s3"}>
          <button class="job-choice drive-confirm" disabled={!!missing() || busy()} onClick={addBucket}>
            {busy() ? "Looking…" : "Add"}
          </button>
        </Show>
      </div>
    </dialog>
  );
}

/** A file's older versions, as its service keeps them, each of which can be brought back. */
export function Versions(props: { path: string; onBack: () => void; onClose: () => void }) {
  const [versions] = createResource(() => cloudVersions(props.path));
  const [failure, setFailure] = createSignal<string>();
  const [busy, setBusy] = createSignal<string>();
  let dialog!: HTMLDialogElement;
  let close!: ReturnType<typeof openSheet>;
  const name = props.path.slice(props.path.lastIndexOf("\\") + 1);

  async function back(id: string) {
    setBusy(id);
    try {
      await bringBack(props.path, id);
      close(props.onBack);
    } catch (reason) {
      setFailure(String(reason));
    } finally {
      setBusy(undefined);
    }
  }

  onMount(() => {
    close = openSheet(dialog);
  });

  return (
    <dialog ref={dialog} class="settings confirm drive-sheet cloud-sheet" aria-label={`Versions of ${name}`} onClose={props.onClose}>
      <h2>Versions of {name}</h2>
      <p class="drive-hint" classList={{ "properties-failure": !!(failure() || versions.error) }} role="status">
        {failure() ??
          (versions.error
            ? String(versions.error)
            : versions.loading
              ? "Asking the service…"
              : versions()?.length
                ? "The newest is first. Bringing one back keeps the one there now as a version too."
                : "The service keeps no older versions of this file.")}
      </p>
      <ul class="cloud-versions">
        <For each={versions()}>
          {(version) => (
            <li>
              <span>{isoText(filetimeToMs(version.modified))}</span>
              <span class="cloud-version-size">{formatSize(version.size)}</span>
              <button class="settings-chip" disabled={!!busy()} onClick={() => back(version.id)}>
                {busy() === version.id ? "Bringing back…" : "Bring back"}
              </button>
            </li>
          )}
        </For>
      </ul>
      <div class="confirm-buttons properties-buttons">
        <span class="properties-said" />
        <button class="job-choice" onClick={() => close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}

/** The places in Settings: their order, Google's Docs as PDFs, and forgetting one. */
export function CloudSettings(props: { onFailure: (failure: unknown) => void }) {
  const change = (work: Promise<unknown>) => work.then(readCloudPlaces).catch(props.onFailure);
  const move = (place: CloudPlace, by: number) => {
    const ids = cloudPlaceList().map((one) => one.id);
    const at = ids.indexOf(place.id);
    ids.splice(at, 1);
    ids.splice(Math.max(0, Math.min(ids.length, at + by)), 0, place.id);
    change(reorderPlaces(ids));
  };
  return (
    <>
      <p class="settings-note">
        Each opens as a folder of its own. Files open from a copy kept here, which the Archives cache holds. Removing a
        place only forgets it here: nothing in the cloud changes.
      </p>
      <ul class="cloud-settings">
        <For each={cloudPlaceList()}>
          {(place, at) => (
            <li>
              <span class="cloud-settings-name">
                {place.name}
                <span class="settings-note">
                  {KIND_LABELS[place.kind]}, {place.account}
                </span>
              </span>
              <button class="settings-chip" aria-label={`Move ${place.name} up`} disabled={at() === 0} onClick={() => move(place, -1)}>
                Up
              </button>
              <button
                class="settings-chip"
                aria-label={`Move ${place.name} down`}
                disabled={at() === cloudPlaceList().length - 1}
                onClick={() => move(place, 1)}
              >
                Down
              </button>
              <button class="settings-chip" onClick={() => change(removePlace(place.id))}>
                Remove
              </button>
              <Show when={place.kind === "google"}>
                <Switch
                  label="Docs, Sheets and Slides as PDFs"
                  note="Otherwise they come down as Word, Excel and PowerPoint files"
                  checked={place.pdf}
                  onChange={(on) => change(setCloudPdf(place.id, on))}
                />
              </Show>
            </li>
          )}
        </For>
      </ul>
      <button class="settings-chip" onClick={() => setAddingPlace(true)}>
        Add a cloud place…
      </button>
    </>
  );
}
