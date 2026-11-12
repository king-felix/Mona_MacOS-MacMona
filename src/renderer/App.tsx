import type { JSX } from "react";
import { Harness } from "./design/Harness";
import { Shell } from "./shell/Shell";

/**
 * The product shell is the default. The P06 design harness remains reachable
 * only when the main process loads the renderer with `?harness=1` for visual
 * evidence; it is never a production fallback.
 */
export function App(): JSX.Element {
  const harness = new URLSearchParams(window.location.search).get("harness") === "1";
  return harness ? <Harness /> : <Shell />;
}
