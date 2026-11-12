import type { JSX } from "react";
import { Harness } from "./design/Harness";

/**
 * P06 ships the design harness. Every screen is fixture-backed and labeled;
 * P07 replaces this entry point with the real catalog and engine shell.
 */
export function App(): JSX.Element {
  return <Harness />;
}
