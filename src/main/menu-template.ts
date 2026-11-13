import type { MenuItemConstructorOptions } from "electron";

/**
 * The application menu as data, with no Electron runtime import, so its
 * accelerators can be asserted in a plain Node test.
 *
 * The View menu is written out rather than using the built-in `viewMenu` role
 * for two reasons. The role's Zoom In registers only `CommandOrControl+Plus`,
 * which on a US layout is Command-Shift-equals; the plain Command-equals most
 * people press was unbound. And the role always shows a Developer Tools item,
 * which does nothing in a build that deliberately disables devtools.
 */
export interface ApplicationMenuTemplateOptions {
  appName: string;
  developerTools: boolean;
  onOpenProject?: () => void;
  onInterrupt?: () => void;
  onShowBlockers?: () => void;
  onToggleFocus?: () => void;
  onQuit?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
}

export function applicationMenuTemplate(
  options: ApplicationMenuTemplateOptions,
): MenuItemConstructorOptions[] {
  return [
    {
      label: options.appName,
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
    {
      label: "View",
      submenu: [
        { role: "reload" },
        ...(options.developerTools
          ? ([{ role: "toggleDevTools" }] as MenuItemConstructorOptions[])
          : []),
        { type: "separator" },
        {
          id: "zoom-reset",
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          click: () => options.onZoomReset?.(),
        },
        {
          id: "zoom-in",
          label: "Zoom In",
          accelerator: "CmdOrCtrl+Plus",
          click: () => options.onZoomIn?.(),
        },
        // The accelerator users actually press. "+" needs Shift on a US
        // layout, so Command-equals is bound separately and stays out of the
        // visible menu rather than appearing twice.
        {
          id: "zoom-in-equals",
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          visible: false,
          click: () => options.onZoomIn?.(),
        },
        {
          id: "zoom-out",
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: () => options.onZoomOut?.(),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
}
