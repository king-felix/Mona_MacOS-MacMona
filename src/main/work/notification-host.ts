import { Notification } from "electron";
import type { NotificationDelivery, PolishFocusTarget } from "../../shared/contracts/polish";
import type { NotificationHost } from "./notifications";

export interface ElectronNotificationOptions {
  /** A real click on the system notification; never a simulated one. */
  onFocus: (target: PolishFocusTarget) => void;
  /** Give a slow system more than one frame to report `show` or `failed`. */
  confirmMs?: number;
}

/**
 * The only place Mona hands text to the macOS notification center. Bodies are
 * already redacted by the planner; this adapter does not add project detail.
 * A notification is never used to drive work — a click only focuses the app.
 *
 * Delivery is reported as the system reported it. `show` resolves `shown`,
 * `failed` resolves `failed`, and a system that says nothing within the
 * confirmation window resolves `handed_over` — accepted, but unconfirmed. That
 * distinction is what keeps Settings from calling a refused alert delivered.
 */
export function createElectronNotificationHost(
  options: ElectronNotificationOptions,
): NotificationHost {
  // A Notification's `click` only fires while a reference is alive; a local that
  // is released as soon as `show()` returns would drop the user's click.
  const live = new Set<Notification>();
  const supported = (): boolean => {
    try {
      return Notification.isSupported();
    } catch {
      return false;
    }
  };
  return {
    available: supported,
    note: () =>
      supported()
        ? "macOS notifications are available. Delivery also depends on the system permission for Mona."
        : "The system reports that notifications are unsupported in this environment.",
    deliver: ({ title, body, focus }) =>
      new Promise<Exclude<NotificationDelivery, "suppressed">>((resolve) => {
        let settled = false;
        const settle = (value: Exclude<NotificationDelivery, "suppressed">): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => settle("handed_over"), options.confirmMs ?? 1_500);
        try {
          const notification = new Notification({ title, body });
          live.add(notification);
          notification.on("show", () => settle("shown"));
          notification.on("failed", () => {
            live.delete(notification);
            settle("failed");
          });
          notification.on("click", () => options.onFocus(focus));
          notification.on("close", () => {
            live.delete(notification);
          });
          notification.show();
        } catch {
          settle("failed");
        }
      }),
  };
}
