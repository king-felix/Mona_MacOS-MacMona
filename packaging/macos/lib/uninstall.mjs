/**
 * The removal utility's contract, checked as code.
 *
 * A root script that can delete an arbitrary path is one edit away from
 * deleting a home directory. These are the bounds the build refuses to ship
 * without; the utility's own rehearsal (and the P23 smoke) prove the behaviour.
 */
export function reviewUninstallScript(text) {
  const problems = [];
  if (!text.startsWith("#!/bin/sh")) problems.push("it is not a POSIX sh script");
  if (!/^set -eu$/m.test(text)) problems.push("it does not run with `set -eu`");
  for (const [pattern, description] of [
    [/rm -rf \/\s*$/m, "a delete of the filesystem root"],
    [/rm -rf \/Users\/\*/, "a delete of every user"],
    [/rm -rf \$HOME($|[^/a-zA-Z_.-])/m, "a delete of an unresolved home"],
    [/\/Users\/\*\/Library/, "a walk of every user's Library"],
    [/rm -rf "[^"]*\*/, "a wildcard path removal"],
    [/--all-users\s*\)/, "an all-users mode"],
  ]) {
    if (pattern.test(text)) problems.push(`it contains ${description}`);
  }
  for (const required of [
    "owned-paths.json",
    "com.mona.workbench",
    "com.mona.workbench.service",
    "--dry-run",
    "--remove-user-data",
  ]) {
    if (!text.includes(required)) problems.push(`it does not mention ${required}`);
  }
  if (!/refus/i.test(text)) problems.push("it never refuses an unrecognized path");
  return problems;
}
