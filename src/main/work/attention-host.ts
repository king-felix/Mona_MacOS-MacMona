import { app, Menu, nativeImage, powerSaveBlocker, Tray } from "electron";
import type { AttentionHost, KeepAwakeHost } from "./attention";

/**
 * An 18 pt template image (36 px @2x): a half-filled ring, the same mark the
 * shell uses. Template images are tinted by macOS for light and dark menu bars.
 */
const TRAY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAcUlEQVR42u2Y2w0AIAgD3X9pHMGAVs7YJnzaXIiP4hjWR4pFISCuwsVmYUCOgmXM5VBZM3mnsiZSoIqBbD9VF8o2ebW1fwBFA1AoumMgAxmoCtR+7H1TP/m44uIHMqAhIywu5CPHIOSgiB2lkZ8NVrsmrA0KEyTTzQMAAAAASUVORK5CYII=";

export interface ElectronAttentionOptions {
  onOpen: () => void;
  onInterrupt: () => void;
  onShowBlockers: () => void;
  onQuit: () => void;
}

/**
 * Native menu-bar and Dock presence. A failure to create the tray is reported
 * rather than swallowed: Settings can then say the menu-bar item is missing
 * instead of showing a control that does nothing.
 */
export function createElectronAttentionHost(options: ElectronAttentionOptions): AttentionHost {
  let tray: Tray | null = null;
  let note = "menu-bar status has not been installed";
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(TRAY_PNG_BASE64, "base64"), {
      scaleFactor: 2,
    });
    image.setTemplateImage(true);
    tray = new Tray(image);
    tray.setToolTip("Mona");
    tray.on("click", () => options.onOpen());
    const menu = Menu.buildFromTemplate([
      { label: "Open Mona", click: () => options.onOpen() },
      { type: "separator" },
      { label: "Interrupt current work", click: () => options.onInterrupt() },
      { label: "Show blockers", click: () => options.onShowBlockers() },
      { type: "separator" },
      { label: "Quit Mona", click: () => options.onQuit() },
    ]);
    tray.on("right-click", () => tray?.popUpContextMenu(menu));
    note = "menu-bar status is installed; the Dock badge is a native app badge";
  } catch (error) {
    tray = null;
    note = `menu-bar status unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  const setBadge = (badge: string): void => {
    try {
      app.dock?.setBadge(badge);
    } catch {
      // A Dock badge is cosmetic; losing it must not break attention state.
    }
  };

  return {
    installed: () => tray !== null,
    note: () => note,
    setBadge,
    setMenu: (title, tooltip) => {
      if (!tray) return;
      try {
        tray.setTitle(title);
        tray.setToolTip(tooltip);
      } catch {
        // The tray can disappear during shutdown; state remains authoritative.
      }
    },
    setLoginItem: (openAtLogin) => {
      try {
        app.setLoginItemSettings({ openAtLogin });
      } catch {
        // Reported through loginItem() by re-reading the system setting.
      }
    },
    loginItem: () => {
      try {
        return app.getLoginItemSettings().openAtLogin === true;
      } catch {
        return false;
      }
    },
  };
}

/** Power assertions scoped to active work; the controller owns start/stop pairing. */
export function createElectronKeepAwakeHost(): KeepAwakeHost {
  return {
    start: () => powerSaveBlocker.start("prevent-app-suspension"),
    stop: (id) => {
      try {
        if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
      } catch {
        // Already released; nothing to do.
      }
    },
  };
}
