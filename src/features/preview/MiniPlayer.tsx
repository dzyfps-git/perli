import { Show } from "solid-js";
import { audio, hasNext, mini, now, playing, skip, stop } from "./nowPlaying";

const ICON_PLAY = "";
const ICON_PAUSE = "";
const ICON_NEXT = "";
const ICON_STOP = "";

/**
 * The song that plays on after its preview closed: a disc on the sidebar that turns while it
 * plays, with play and next beside it. A click on the disc goes back to the full player.
 */
export function MiniPlayer(props: { onOpen: () => void }) {
  return (
    <Show when={mini() && now()}>
      {(song) => (
        <div class="mini-player" role="group" aria-label={`Now playing: ${song().title}`}>
          <button
            class="mini-disc"
            data-playing={playing() || undefined}
            aria-label={`Back to ${song().title}`}
            style={song().cover ? { "--cover": `url("${song().cover}")` } : undefined}
            onClick={props.onOpen}
          >
            <span class="mini-hole" aria-hidden="true" />
          </button>
          <span class="mini-title">{song().title}</span>
          <button
            class="mini-button"
            aria-label={playing() ? "Pause" : "Play"}
            onClick={() => (audio.paused ? void audio.play().catch(() => {}) : audio.pause())}
          >
            {playing() ? ICON_PAUSE : ICON_PLAY}
          </button>
          <Show when={hasNext()}>
            <button class="mini-button" aria-label="Next song" onClick={() => void skip().catch(stop)}>
              {ICON_NEXT}
            </button>
          </Show>
          <button class="mini-button" aria-label="Stop" onClick={stop}>
            {ICON_STOP}
          </button>
        </div>
      )}
    </Show>
  );
}
