import { useEffect, useRef, useState, type JSX } from "react";
import { Notification, type NotificationProps } from "../design/primitives";

/** Routine receipts leave the work surface after five seconds of visible,
 * unattended time. Attention remains until acknowledged. Pause for reading. */
export function TransientNotice(props: NotificationProps): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [fading, setFading] = useState(false);
  const remaining = useRef(5000);
  const dismiss = useRef(props.onDismiss);
  dismiss.current = props.onDismiss;
  useEffect(() => {
    remaining.current = 5000;
    setFading(false);
  }, [props.title, props.tone]);
  useEffect(() => {
    const update = (): void => setHidden(document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const paused = hovered || focused || hidden;
  useEffect(() => {
    if (paused || props.tone !== "success") return;
    const start = Date.now();
    const timer = window.setTimeout(() => setFading(true), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - start));
    };
  }, [paused, props.title, props.tone]);
  useEffect(() => {
    if (!fading || paused) return;
    const timer = window.setTimeout(() => dismiss.current?.(), 180);
    return () => window.clearTimeout(timer);
  }, [fading, paused]);
  return (
    <div
      className={`toast ${fading && !paused ? "toast--leaving" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <Notification {...props} />
    </div>
  );
}
