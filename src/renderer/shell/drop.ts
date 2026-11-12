/**
 * Folder-drop rules for the window, kept out of the component so they can be
 * tested: exactly one folder, a real local path, and a concrete reason when
 * either is missing. The resolved path still goes through the main-process
 * validator, so this is a first, fast filter with honest messages — never the
 * authority on what may be opened.
 */

export interface DroppedSelection {
  path: string | null;
  error: string | null;
}

export function selectDroppedPath(
  files: ReadonlyArray<unknown>,
  resolvePath: (file: unknown) => string | null,
): DroppedSelection {
  if (files.length === 0) {
    return {
      path: null,
      error: "That drop contained no files. Drop one project folder.",
    };
  }
  if (files.length > 1) {
    return {
      path: null,
      error: `Mona opens one project at a time; ${files.length} items were dropped. Drop a single folder.`,
    };
  }
  const path = resolvePath(files[0]);
  if (!path) {
    return {
      path: null,
      error:
        "That item has no local folder path. Use File → Open Project… (⌘O) to choose the folder instead.",
    };
  }
  if (!path.startsWith("/")) {
    return {
      path: null,
      error: "That item is not a local folder. Mona only opens folders on this Mac.",
    };
  }
  return { path, error: null };
}
