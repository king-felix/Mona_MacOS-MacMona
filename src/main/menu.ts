import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { applicationMenuTemplate } from "./menu-template";

/**
 * Native application menu with a real Services submenu. Closing the last
 * window keeps the app alive on macOS; Quit is the explicit stop. Interrupt is
 * a deliberate Command-period, never a single keystroke that could fire while
 * typing.
 *
 * The template itself lives in `menu-template.ts` so its accelerators are
 * asserted in a plain Node test without an Electron runtime.
 */
export interface ApplicationMenuOptions {
  onOpenProject?: () => void;
  onInterrupt?: () => void;
  onShowBlockers?: () => void;
  onToggleFocus?: () => void;
  onQuit?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
}

export interface ApplicationMenuHandle {
  /** Reflect whether an active turn exists; an unavailable action stays dim. */
  setInterruptEnabled(enabled: boolean): void;
}

export function installApplicationMenu(
  options: ApplicationMenuOptions = {},
): ApplicationMenuHandle {
  const template: MenuItemConstructorOptions[] = applicationMenuTemplate({
    appName: app.getName(),
    developerTools: process.env.MONA_DEVTOOLS === "1",
    ...options,
  });
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return {
    setInterruptEnabled: (enabled: boolean) => {
      const item = menu.getMenuItemById("interrupt-work");
      if (item) item.enabled = enabled;
    },
  };
}
