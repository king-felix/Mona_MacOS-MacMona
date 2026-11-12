import { app, Menu, type MenuItemConstructorOptions } from "electron";

/**
 * Native application menu with a real Services submenu. Closing the last
 * window keeps the app alive on macOS; Quit is the explicit stop. Interrupt is
 * a deliberate Command-period, never a single keystroke that could fire while
 * typing.
 */
export interface ApplicationMenuOptions {
  onOpenProject?: () => void;
  onInterrupt?: () => void;
  onShowBlockers?: () => void;
  onToggleFocus?: () => void;
  onQuit?: () => void;
}

export interface ApplicationMenuHandle {
  /** Reflect whether an active turn exists; an unavailable action stays dim. */
  setInterruptEnabled(enabled: boolean): void;
}

export function installApplicationMenu(
  options: ApplicationMenuOptions = {},
): ApplicationMenuHandle {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.getName(),
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        // An explicit handler interrupts work before quitting. Without one the
        // standard role keeps Command-Q functional rather than dead.
        options.onQuit
          ? {
              label: "Quit Mona",
              accelerator: "Command+Q",
              click: () => options.onQuit?.(),
            }
          : { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Open Project…",
          accelerator: "CmdOrCtrl+O",
          click: () => options.onOpenProject?.(),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "Work",
      submenu: [
        {
          id: "interrupt-work",
          label: "Interrupt Current Work",
          accelerator: "CmdOrCtrl+.",
          enabled: false,
          click: () => options.onInterrupt?.(),
        },
        {
          label: "Show Blockers",
          accelerator: "CmdOrCtrl+Shift+B",
          click: () => options.onShowBlockers?.(),
        },
        { type: "separator" },
        {
          label: "Toggle Focus Mode",
          accelerator: "CmdOrCtrl+Shift+F",
          click: () => options.onToggleFocus?.(),
        },
      ],
    },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return {
    setInterruptEnabled: (enabled: boolean) => {
      const item = menu.getMenuItemById("interrupt-work");
      if (item) item.enabled = enabled;
    },
  };
}
