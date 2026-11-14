/**
 * R11 — when a window-level accelerator is allowed to act.
 *
 * The shell listens on `window` for ⌘K, ⌘J, ⌘O, ⌘⇧F, ⌘/, ⌘F and ⌘1–⌘9. Those
 * are correct in the main window and wrong in two states, both of which are
 * ordinary rather than exotic: while an IME is composing text, and while a modal
 * dialog owns the keyboard. Keeping the decision here — instead of as two `if`
 * statements inside a listener — is what makes it testable without a browser.
 *
 * The policy is deliberately blunt: a modal blocks every accelerator. It does
 * not block Escape, because the dialog handles Escape itself and stops the event
 * before it reaches the window listener.
 */

export interface AcceleratorScope {
  /** True while an IME composition is in progress. */
  composing: boolean;
  /** True when a modal dialog is open anywhere in the document. */
  modalOpen: boolean;
}

/**
 * Read the scope from a live document. Kept separate from the policy so a test
 * can pass a plain object.
 */
export function acceleratorScope(
  documentLike: Pick<Document, "querySelector"> | null,
): AcceleratorScope {
  const modal = documentLike?.querySelector('[role="dialog"][aria-modal="true"]') ?? null;
  return { composing: false, modalOpen: modal !== null };
}

/**
 * True when the window listener may act on this keystroke. `composing` comes from
 * the event itself; a modal comes from the document.
 */
export function acceleratorAllowed(
  event: { isComposing?: boolean; keyCode?: number },
  scope: Pick<AcceleratorScope, "modalOpen">,
): boolean {
  if (scope.modalOpen) return false;
  // `isComposing` is the standard flag; keyCode 229 is what WebKit reports for the
  // keystroke that starts a composition on macOS, where `isComposing` can still
  // be false on that first event.
  if (event.isComposing === true) return false;
  if (event.keyCode === 229) return false;
  return true;
}
