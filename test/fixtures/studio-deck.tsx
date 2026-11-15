/** Real Studio renderer with deterministic local records. No bridge, engine,
 * provider, or credential access. Only loaded by the browser smoke runner. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { StudioScreen } from "../../src/renderer/shell/Studio";
import { TransientNotice } from "../../src/renderer/shell/TransientNotice";
import { applyTheme, applyIntensity } from "../../src/renderer/design/tokens";
import { studioDetail, studioSnapshot } from "../helpers/studio-fixtures";
import type { StoredEventSummary } from "../../src/shared/contracts/project-bridge";
import "../../src/renderer/styles.css";
const params = new URLSearchParams(location.search);
applyTheme(params.get("theme") === "light" ? "daybreak" : "afterglow");
applyIntensity("vivid");
const detail = studioDetail();
detail.project.name = "Mona";
detail.project.monogram = "MO";
detail.usage = {
  ...detail.usage,
  inputTokens: 338526,
  outputTokens: 20461,
  cachedTokens: 328000,
  costUsd: 0.2862,
};
const initial = studioSnapshot();
initial.cost = {
  observed: true,
  costUsd: 0.2862,
  costComplete: false,
  turns: 35,
  label: "At least $0.2862 · some turns unpriced",
};
initial.activeTurnId = "turn-live";
initial.connection = {
  ...initial.connection,
  state: "running",
  since: new Date(Date.now() - 131000).toISOString(),
  lastEventAt: new Date().toISOString(),
};
initial.controls.canInterrupt = true;
initial.canSubmit = false;
initial.cannotSubmitReason = "A turn is active. Queue a follow-up, or interrupt first.";
initial.display = { showReasoning: true };
function event(seq: number, kind: string, itemKind: string, text: string): StoredEventSummary {
  return {
    seq,
    threadId: initial.threadId!,
    turnId: initial.activeTurnId,
    itemId: `item-${seq}`,
    timestamp: new Date(Date.now() - (50 - seq) * 1000).toISOString(),
    kind,
    payload:
      kind === "item.delta"
        ? { kind: itemKind, delta: text }
        : {
            item: {
              id: `item-${seq}`,
              kind: itemKind,
              status: "completed",
              detail: text,
              name: itemKind === "tool_call" ? "shell" : undefined,
            },
          },
  };
}
const first = [
  event(
    1,
    "item.completed",
    "user_message",
    "Make Studio feel alive. Keep the console and prompt in view, and show me what the agent is doing.",
  ),
  event(
    2,
    "item.completed",
    "agent_message",
    "## A workspace that stays with you\n\nI’m tightening the layout around two things: **watching work happen** and **giving the next direction**.\n\n- Keep the transcript inside a bounded, scrollable surface.\n- Put Submit, Pause, and Interrupt within reach.\n- Show observed activity without guessing what a quiet model is doing.",
  ),
  event(
    3,
    "item.completed",
    "tool_call",
    "npm run typecheck\n\n✓ Main process types\n✓ Renderer types\n✓ Shared contracts\n\nAll checks passed.",
  ),
  event(
    4,
    "item.completed",
    "agent_message",
    "The console now holds its place as new output arrives. I’m checking the small-window layout next, including 200% zoom and long tool output.",
  ),
  event(
    5,
    "item.delta",
    "agent_reasoning",
    "I’m checking the available viewport height and the composer’s measured chrome. Both layouts should keep the controls in view as the transcript grows.",
  ),
];
const noop = () => undefined;
function Fixture() {
  const [focus, setFocus] = useState(params.get("focus") !== "off");
  const [draft, setDraft] = useState("Keep going. Make it feel effortless.");
  const [events, setEvents] = useState(first);
  const [snapshot, setSnapshot] = useState(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const controls = {
    append: () =>
      setEvents((previous) => [
        ...previous,
        ...Array.from({ length: 1200 }, (_, index) =>
          event(
            index + 100,
            "item.completed",
            "agent_message",
            `Stored event ${index + 1}\n\n${"Long agent output that must stay in the scrollable console. ".repeat(12)}`,
          ),
        ),
      ]),
    long: () =>
      setEvents([event(1, "item.delta", "agent_message", "A long live item\n".repeat(8000))]),
    notice: () => setNotice("Copied to clipboard"),
    ready: () =>
      setSnapshot((value) => ({
        ...value,
        activeTurnId: null,
        canSubmit: true,
        cannotSubmitReason: null,
        connection: { ...value.connection, state: "connected" },
      })),
    quiet: () =>
      setSnapshot((value) => ({
        ...value,
        connection: {
          ...value.connection,
          lastEventAt: new Date(Date.now() - 90000).toISOString(),
        },
      })),
  };
  Object.assign(window, { deck: controls });
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const action = event.data as keyof typeof controls;
      if (Object.hasOwn(controls, action)) controls[action]();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  });
  return (
    <div className={`harness shell shell--studio ${focus ? "shell--focus" : ""}`}>
      <aside className="rail">
        <div className="rail__brand">✦ Mona</div>
        <nav aria-label="Workspace">
          {["Home", "Studio", "Work board", "Changes", "Cost lens", "Agents", "Settings"].map(
            (name) => (
              <button
                key={name}
                className={`button button--ghost ${name === "Studio" ? "rail__link--active" : ""}`}
                type="button"
              >
                {name}
              </button>
            ),
          )}
        </nav>
      </aside>
      <main className="harness__main shell__main">
        <div className="shell-topbar">
          <span>WORKSPACE / Studio</span>
          <span>Local renderer fixture · no provider requests</span>
        </div>
        {notice ? (
          <TransientNotice title={notice} tone="success" onDismiss={() => setNotice(null)} />
        ) : null}
        <StudioScreen
          detail={{ ...detail, events }}
          studio={snapshot}
          studioBusy={false}
          mode="work"
          draft={draft}
          draftStatus="saved"
          inspectorTab="task"
          onInspectorTab={noop}
          focusMode={focus}
          focusPreference={focus}
          windowFullscreen={{ available: false, fullscreen: false, pending: false, epoch: 0 }}
          favorites={[]}
          onToggleFocus={() => setFocus((value) => !value)}
          onUseFavorite={noop}
          onRequestSaveFavorite={noop}
          onRemoveFavorite={noop}
          onDraft={setDraft}
          onMode={noop}
          onOpenFolder={noop}
          onShowBoard={noop}
          onStart={noop}
          onSubmit={() => setNotice("Submitted (local fixture) ")}
          onInterrupt={noop}
          onPause={noop}
          onResumeQueue={noop}
          onCancelQueued={noop}
          onStop={noop}
          onReconcile={noop}
          onMentionFile={noop}
          onQueueFollowUp={noop}
          search={{
            query,
            busy: false,
            error: null,
            hits: [],
            anchor: null,
            onQuery: setQuery,
            onJump: noop,
            onClear: () => setQuery(""),
          }}
        />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
