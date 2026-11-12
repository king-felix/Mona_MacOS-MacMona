import { useEffect, useState, type JSX } from "react";
import type { AppInfo, AppPathInfo, ToolDiscovery } from "../shared/contracts/bridge";

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; app: AppInfo; paths: AppPathInfo; tools: ToolDiscovery[] }
  | { phase: "error"; message: string };

const NAV = ["Projects", "Work", "Cost", "Settings"];

export function App(): JSX.Element {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        if (typeof window.mona !== "object" || window.mona === null) {
          throw new Error("The trusted preload bridge is unavailable.");
        }
        const [app, paths, tools] = await Promise.all([
          window.mona.getAppInfo(),
          window.mona.getPaths(),
          window.mona.discoverTools(["codewhale", "git", "node"]),
        ]);
        if (!cancelled) setState({ phase: "ready", app, paths, tools });
      } catch (error) {
        if (!cancelled) {
          setState({
            phase: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        document.body.dataset.ready = "true";
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app-shell">
      <aside className="rail" aria-label="Primary">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ◐
          </span>
          <span className="brand-name">Mona</span>
        </div>
        <nav className="nav" aria-label="Sections">
          {NAV.map((item, index) => (
            <button
              key={item}
              className={index === 0 ? "nav-item nav-item--current" : "nav-item"}
              type="button"
              data-nav
              aria-current={index === 0 ? "page" : undefined}
              disabled
            >
              {item}
            </button>
          ))}
        </nav>
        <p className="rail-note">Foundation shell · no engine attached</p>
      </aside>

      <main className="stage">
        <header className="hero">
          <p className="eyebrow">Mona for macOS · foundation</p>
          <h1>A quiet studio for real work.</h1>
          <p className="lede">
            Finder-first projects, durable prompt work, visible cost. This window is the P02 shell;
            it makes no model calls and claims nothing about the engine yet.
          </p>
        </header>

        <section className="status-grid" aria-label="Status">
          <article className="card">
            <p className="card-label">Engine</p>
            <p className="card-value card-value--muted">Not connected</p>
            <p className="card-detail">
              The Runtime adapter lands in P03. No runtime process is owned here.
            </p>
          </article>
          <article className="card">
            <p className="card-label">Inference overhead</p>
            <p className="card-value">0 calls</p>
            <p className="card-detail">Navigation, state, and status use local logic only.</p>
          </article>
          <article className="card">
            <p className="card-label">Cost</p>
            <p className="card-value card-value--muted">Unknown</p>
            <p className="card-detail">
              Unknown is not zero. Cost appears only when the engine reports usage.
            </p>
          </article>
        </section>

        <section className="facts" aria-label="Application facts">
          <h2>Facts</h2>
          {state.phase === "loading" && <p className="fact-line">Reading local facts…</p>}
          {state.phase === "error" && (
            <p className="fact-line fact-line--error" role="alert">
              {state.message}
            </p>
          )}
          {state.phase === "ready" && (
            <>
              <p className="fact-line" data-testid="app-version">
                Mona {state.app.version}
              </p>
              <p className="fact-line">
                Electron {state.app.electron} · Chromium {state.app.chrome} · {state.app.arch}
              </p>
              <p className="fact-line">Support: {state.paths.support}</p>
              <p className="fact-line">Logs: {state.paths.logs}</p>
              <ul className="tool-list">
                {state.tools.map((tool) => (
                  <li key={tool.name}>
                    <span className="tool-name">{tool.name}</span>
                    <span className={tool.path ? "tool-path" : "tool-path tool-path--missing"}>
                      {tool.path ?? "not found"}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
