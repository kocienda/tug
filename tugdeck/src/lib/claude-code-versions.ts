/**
 * claude-code-versions.ts — the two Claude Code versions Tug is built with,
 * each read from its one source in the checkout.
 *
 *  - **Validated**: `capabilities/LATEST`, the version of the newest
 *    `just capture-capabilities` baseline. It is whatever the last capture
 *    was, so nobody keeps it by hand.
 *  - **Floor**: `capabilities/FLOOR`, the oldest Claude Code Tug will run
 *    against. That one is a person's decision — only a person knows what Tug
 *    started depending on — and the file is where the decision is written
 *    down, as plain text so that a shell script can read it as easily as this
 *    module does.
 *
 * A Vite build or dev server inlines both through `define` (see
 * `claudeCodeVersionDefines` in `vite.config.ts`), so the bundle carries two
 * string literals and touches no file. Anything else that imports deck source —
 * `bun test`, an app-test, a script — has no `define` and reads the same two
 * files off the checkout instead. Either way there is no literal here to drift.
 *
 * @module lib/claude-code-versions
 */

declare const __TUG_CLAUDE_CODE_VALIDATED__: string | undefined;
declare const __TUG_CLAUDE_CODE_FLOOR__: string | undefined;

/**
 * Read one of the two files from the checkout. Reached only outside a Vite
 * build, where the runtime is bun and the source tree is on disk.
 */
function fromCheckout(file: "LATEST" | "FLOOR"): string {
  const fs = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  const version = fs
    .readFileSync(path.join(import.meta.dir, "..", "..", "..", "capabilities", file), "utf-8")
    .trim();
  if (!version) throw new Error(`capabilities/${file} is empty`);
  return version;
}

/** The Claude Code version of the newest capture baseline (`capabilities/LATEST`). */
export const VALIDATED_CLAUDE_CODE_VERSION: string =
  typeof __TUG_CLAUDE_CODE_VALIDATED__ === "string"
    ? __TUG_CLAUDE_CODE_VALIDATED__
    : fromCheckout("LATEST");

/** The oldest Claude Code Tug will run against (`capabilities/FLOOR`). */
export const CLAUDE_CODE_FLOOR_VERSION: string =
  typeof __TUG_CLAUDE_CODE_FLOOR__ === "string"
    ? __TUG_CLAUDE_CODE_FLOOR__
    : fromCheckout("FLOOR");
