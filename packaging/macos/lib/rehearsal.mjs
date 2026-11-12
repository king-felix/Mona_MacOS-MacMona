import { resolve, sep } from "node:path";

/**
 * Where an installer rehearsal may run.
 *
 * `preinstall`, `postinstall`, and the removal utility all treat an empty
 * `MONA_*_ROOT` as "the real system", which is exactly right when Apple
 * Installer runs them and catastrophic when a build step runs them without the
 * environment. This function is the mechanism that makes the second case
 * impossible: a rehearsal root must be a fresh directory inside this process's
 * temporary tree, and never `/` or the temporary directory itself.
 */
export function assertRehearsalRoot(root, temporaryDirectory) {
  const temporary = resolve(temporaryDirectory);
  const candidate = resolve(root);
  if (candidate === "/" || candidate === temporary || !candidate.startsWith(`${temporary}${sep}`)) {
    const error = new Error(
      "a rehearsal root must be a temporary directory, never the real filesystem",
    );
    error.details = { root: candidate, temporary };
    throw error;
  }
  return candidate;
}
