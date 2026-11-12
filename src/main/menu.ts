import { app, Menu, type MenuItemConstructorOptions } from "electron";

/**
 * Native application menu with a real Services submenu. Closing the last
 * window keeps the app alive on macOS; Quit is the explicit stop. Opening a
 * project is a real folder dialog, not a renderer-only shortcut.
 */
export interface ApplicationMenuOptions {
  onOpenProject?: () => void;
}

export function installApplicationMenu(options: ApplicationMenuOptions = {}): void {
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
        { role: "quit" },
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
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
