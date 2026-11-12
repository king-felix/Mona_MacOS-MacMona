import { app, Menu, type MenuItemConstructorOptions } from "electron";

/**
 * Native application menu with a real Services submenu. Closing the last
 * window keeps the app alive on macOS; Quit is the explicit stop.
 */
export function installApplicationMenu(): void {
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
      submenu: [{ role: "close" }],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
