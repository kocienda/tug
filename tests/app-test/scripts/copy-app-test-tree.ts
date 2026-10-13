/**
 * Copy `tests/app-test` for the selector tests' throwaway trees, leaving behind the
 * run logs and the locally harvested session corpus.
 *
 * `select-tests.ts` reads neither, and the corpus alone is ~170 MB on a machine that
 * has harvested one. (`node_modules` stays: the selector imports `typescript`.) The
 * repo-root `.gitignore` that keeps the corpus out of git is not in a throwaway repo,
 * so a full copy followed by `git add -A` hashed all of it and blew the hook timeout.
 */

import { cpSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Ignored paths under `tests/app-test` (its own `.gitignore` and the root one). */
const LEFT_BEHIND = ["logs", join("corpus", "snapshots"), join("corpus", "manifest.json")];

export function copyAppTestTree(from: string, to: string): void {
    cpSync(from, to, {
        recursive: true,
        filter: (src) => {
            const rel = relative(from, src);
            return !LEFT_BEHIND.some((p) => rel === p || rel.startsWith(p + sep));
        },
    });
}
