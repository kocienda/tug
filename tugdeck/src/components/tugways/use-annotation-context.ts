/**
 * The one builder for an {@link AnnotationContext} — the live inputs the
 * annotator needs beyond the DOM it walks.
 *
 * Every surface that annotates prose assembles the same four pieces: a file
 * name resolver and a commit resolver for the project, a reference resolver
 * over the shared path store, and a {@link VerdictBatcher} across all of
 * them for the late answers. What differs between surfaces is only where
 * the project comes from and what the prose is counted against — the
 * transcript reads its project off the card's session binding and its cwd
 * off the live session, an Overview post reads both off the post's own
 * root. That difference is this hook's parameters; everything else was
 * written twice and is now written once.
 *
 * **The returned context's identity is stable across verdict arrivals, and
 * that is the property this module exists to protect.** Identity changes
 * only when a real input moves — the command catalog, the cwd, the project
 * binding — which is the everything-must-re-mark case and is rare and
 * bounded. Verdicts travel through `context.subscribe` instead, so an
 * answer about one path re-marks only the containers still awaiting one.
 * Folding a resolver version into the memo here is the mistake that once
 * re-annotated *and re-rendered* every block per answer; nothing below
 * reads a version, and nothing added later may.
 *
 * @module components/tugways/use-annotation-context
 */

import { useMemo } from "react";

import type { AnnotationContext } from "@/lib/annotator/types";
import { pathResolutionStore } from "@/lib/annotator/path-resolution";
import { fileNameResolverFor } from "@/lib/annotator/file-name-resolution";
import {
  commitResolverFor,
  NO_COMMIT_VERDICT,
} from "@/lib/annotator/commit-resolution";
import { makeReferenceResolver } from "@/lib/annotator/resolve-reference";
import { resolveSessionRef } from "@/lib/annotator/session-resolution";
import { VerdictBatcher } from "@/lib/annotator/verdict-batching";
import { sessionCitationStore } from "@/lib/session-citation-store";

/**
 * The slash-command gate for a surface with no live session behind it.
 *
 * A module constant rather than an inline arrow, because the gate is a
 * dependency of the context memo: a fresh `() => false` on every render
 * would change the context's identity every render, which is the one thing
 * this module promises not to do.
 */
export const NO_SLASH_COMMANDS = (_name: string): boolean => false;

/** The per-surface inputs to {@link useAnnotationContextFor}. */
export interface AnnotationContextInputs {
  /**
   * The repository the prose is about — the file index's search root and
   * the root a confirmed commit belongs to.
   */
  projectDir: string | null;
  /** Scopes the shared FILETREE feed the name resolver reads. */
  workspaceKey: string | null;
  /**
   * The directory a relative path in the prose is counted from. The live
   * session's cwd where there is a session; the project directory where the
   * prose is read long after its session closed.
   */
  cwd: string | null;
  /**
   * Authoritative clickability gate for slash commands. Must be
   * identity-stable across renders — {@link NO_SLASH_COMMANDS} for a
   * surface with no catalog to consult.
   */
  isKnownSlashCommand: (name: string) => boolean;
  /**
   * Whether this surface's annotated prose can contain `@` atoms. An atom
   * is born confirmed and needs only the roots its value was counted from,
   * which are the two this hook already holds. Off by default: a surface
   * that renders no atoms carries no roots for them, exactly as it did
   * before this hook existed.
   */
  withAtomRoots?: boolean;
}

/**
 * Assemble the annotator's live inputs for one surface.
 *
 * Session scanning is unconditional, and so is the citation store's place
 * in the batcher. A session spelled in assistant prose is the same
 * reference it is in an Overview post and earns the same chip; and a
 * session verdict arriving is what turns a reserved run into a citation, so
 * without the store in the batch a run reserved on the first pass would
 * stay reserved forever. Surfaces that should not scan for sessions at all
 * build their context by hand and omit `resolveSession`, which is what its
 * absence means.
 */
export function useAnnotationContextFor({
  projectDir,
  workspaceKey,
  cwd,
  isKnownSlashCommand,
  withAtomRoots = false,
}: AnnotationContextInputs): AnnotationContext {
  const names = fileNameResolverFor(projectDir, workspaceKey);
  const commits = commitResolverFor(projectDir, workspaceKey);
  const resolvePath = useMemo(
    () => makeReferenceResolver({ paths: pathResolutionStore, names, cwd }),
    [names, cwd],
  );
  const resolveCommit = useMemo(
    () => (sha: string) => commits?.lookup(sha) ?? NO_COMMIT_VERDICT,
    [commits],
  );
  // Verdicts arrive asynchronously, long after the ink they belong to was
  // painted. They travel as batched notifications, not as context identity:
  // consumers subscribe and re-mark only the containers still awaiting an
  // answer. The batcher attaches to the stores lazily, so it needs no
  // effect-cleanup of its own — the last consumer's unsubscribe detaches it.
  const subscribe = useMemo(() => {
    const sources = [
      pathResolutionStore,
      sessionCitationStore,
      names,
      commits,
    ].filter((source): source is NonNullable<typeof source> => source !== null);
    return new VerdictBatcher(sources).subscribe;
  }, [names, commits]);
  // Memoized separately so a consumer can hang an effect on it — both roots
  // arrive after mount, and an atom annotated on the pass that first has one
  // must not be re-stamped on every render after.
  const atomPathRoots = useMemo(
    () => ({ projectDir, cwd }),
    [projectDir, cwd],
  );
  return useMemo(
    () => ({
      isKnownSlashCommand,
      resolvePath,
      resolveCommit,
      resolveSession: resolveSessionRef,
      commitRoot: projectDir,
      ...(withAtomRoots ? { atomPathRoots } : {}),
      subscribe,
    }),
    // `resolveSessionRef` is a module function, not a closure over anything
    // here — the citation store is a singleton keyed by callsign, and a
    // session's identity is app-wide rather than per-surface.
    [
      isKnownSlashCommand,
      resolvePath,
      resolveCommit,
      projectDir,
      withAtomRoots,
      atomPathRoots,
      subscribe,
    ],
  );
}
