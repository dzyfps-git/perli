import { render } from "solid-js/web";
import { MiniVideo } from "./features/mini/MiniVideo";
import { Tooltip } from "./ui/Tooltip";
import "./styles/tokens.css";

/** The film's small window: its own page, so it loads none of the file list. */
render(
  () => (
    <>
      <MiniVideo />
      <Tooltip />
    </>
  ),
  document.getElementById("root")!,
);
