import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyDensity, applyTheme } from "./design/tokens";
import "./styles.css";

// Apply tokens before the first paint so the shell never flashes the wrong
// palette. The harness can switch both at runtime.
applyTheme("daybreak");
applyDensity("comfortable");

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
