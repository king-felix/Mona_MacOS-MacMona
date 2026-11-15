import { useEffect, useMemo, useState, type JSX } from "react";
import type { StoredEventSummary } from "../../shared/contracts/project-bridge";
import type { StudioSnapshot } from "../../shared/contracts/studio";
import { agentSignalAt, projectAgentWork } from "./agent-signal";

export function AgentSignal({
  studio,
  events,
}: {
  studio: StudioSnapshot | null;
  events: StoredEventSummary[];
}): JSX.Element {
  const [now, setNow] = useState(Date.now);
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = (): void => {
      setVisible(!document.hidden);
      setNow(Date.now());
    };
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const hasClock = Boolean(studio?.activeTurnId || studio?.connection.lastEventAt);
  useEffect(() => {
    if (!visible || !hasClock) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible, hasClock]);
  const work = useMemo(() => projectAgentWork(studio, events), [studio, events]);
  const signal = agentSignalAt(studio, work, Math.max(now, Date.now()));
  return (
    <div
      className={`agent-signal agent-signal--${signal.phase}`}
      data-testid="agent-signal"
      data-connection={studio?.connection.state ?? "not_started"}
      data-animated={signal.animate && visible ? "true" : "false"}
      title={signal.detail}
    >
      <span className="agent-signal__orb" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <div className="agent-signal__copy">
        <span className="agent-signal__label" role="status" aria-live="polite" aria-atomic="true">
          {signal.label}
        </span>
        <span className="agent-signal__detail">{signal.detail}</span>
      </div>
      {/* Age updates are deliberately outside the live region. */}
      <span className="agent-signal__contact">{signal.contact}</span>
    </div>
  );
}
