import { isAllowedNavigation } from "./navigation";

/**
 * IPC sender policy, kept free of Electron imports so it can be proven directly.
 *
 * The bridge answers only the top-level local renderer document this process
 * loaded. A subframe, a navigated frame, a remote page, or a destroyed sender is
 * refused before any handler runs. `isAllowedNavigation` decides the origin; the
 * frame check keeps an embedded same-origin frame from borrowing the main
 * document's trust.
 */
export interface SenderLike {
  senderFrame?: { url: string; parent?: unknown } | null;
  sender?: { getURL?: () => string; isDestroyed?: () => boolean };
}

export function senderIsTrusted(event: SenderLike, rendererRoot: string): boolean {
  try {
    return evaluateSender(event, rendererRoot);
  } catch {
    // A destroyed frame can throw while its URL is read; that is not trust.
    return false;
  }
}

function evaluateSender(event: SenderLike, rendererRoot: string): boolean {
  const sender = event.sender;
  if (sender?.isDestroyed && sender.isDestroyed()) return false;
  const frame = event.senderFrame;
  if (frame) {
    // A preload is only installed in the main frame; a child frame invoking the
    // bridge is never the document Mona loaded, whatever its URL says.
    if (frame.parent !== undefined && frame.parent !== null) return false;
    return isAllowedNavigation(frame.url, rendererRoot);
  }
  const url = sender?.getURL ? sender.getURL() : "";
  if (!url) return false;
  return isAllowedNavigation(url, rendererRoot);
}
