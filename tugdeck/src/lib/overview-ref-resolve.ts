/**
 * overview-ref-resolve.ts — is this ref something a click can honestly open?
 *
 * A Overview ref is a verbatim quote from session activity: a path as the
 * wire spelled it, a sha as the model saw it. Quoting is not existing — the
 * spelling may be relative, differently-cased, or stale — so a ref becomes
 * actionable the way every reference in a transcript does: the annotator's
 * own resolvers confirm it first. A path stats (relative ones against the
 * post's `projectDir`), a bare name asks the project's file index the same
 * question Open Quickly asks, and a sha asks git — whose answer doubles as
 * the file list the diff descriptor wants. Only a confirmed answer yields a
 * payload; everything else is `pending` (an answer is coming, the stores
 * notify) or `inert` with the reason on its tooltip. A link that dead-ends
 * is worse than plain text, here as everywhere.
 *
 * The root is the post's own: tugcast stamps the narrated session's project
 * dir onto the post, and the card holds a browse workspace on it — so a
 * post about a closed session, read days later, still resolves against the
 * repo it was written about. A post with no recorded root resolves only
 * absolute targets; the rest are inert, never guessed.
 *
 * The decision is a pure function of its inputs; the resolver stores are
 * injected with production defaults, which is what the unit tests replace.
 *
 * @module lib/overview-ref-resolve
 */

import {
  commitResolverFor,
  type CommitFacts,
  type CommitVerdict,
} from "./annotator/commit-resolution";
import { fileNameResolverFor } from "./annotator/file-name-resolution";
import {
  pathResolutionStore,
  type PathVerdict,
} from "./annotator/path-resolution";
import type { AnnotationPayload } from "./annotator/payloads";
import type { OverviewRef } from "@/protocol";

/** The workspace a post's refs resolve inside. */
export interface OverviewRefRoot {
  /** Absolute project directory — the post's own `projectDir`. */
  projectDir: string;
  /** The tugcast workspace key holding that directory's index. */
  workspaceKey: string;
}

/** What the card should render for one ref right now. */
export type OverviewRefResolution =
  /** Confirmed. The payload is the annotation contract's own — stamped on
   *  the atom, it makes the registry's click and menu the atom's gesture.
   *  `facts` is what a chip that cannot describe itself (a commit hash) says
   *  on hover; the card builds the tip from it. Absent when the label
   *  already says what the thing is. */
  | { state: "actionable"; payload: AnnotationPayload; facts?: CommitFacts }
  /** A probe is in flight; the stores notify when it lands. */
  | { state: "pending" }
  /** Never actionable, and this is why — the atom's tooltip carries it. */
  | { state: "inert"; reason: string };

/** The resolver seams, injectable for tests. */
export interface OverviewRefResolvers {
  lookupPath(raw: string, cwd: string | null): PathVerdict;
  /** `null` when there is no index to ask (no workspace, no connection). */
  lookupName(root: OverviewRefRoot, name: string): PathVerdict | null;
  /** `null` when there is no repository to ask. */
  lookupCommit(root: OverviewRefRoot, sha: string): CommitVerdict | null;
}

const PRODUCTION_RESOLVERS: OverviewRefResolvers = {
  lookupPath: (raw, cwd) => pathResolutionStore.lookup(raw, cwd),
  lookupName: (root, name) =>
    fileNameResolverFor(root.projectDir, root.workspaceKey)?.lookup(name) ??
    null,
  lookupCommit: (root, sha) =>
    commitResolverFor(root.projectDir, root.workspaceKey)?.lookup(sha) ?? null,
};

const NO_ROOT: OverviewRefResolution = {
  state: "inert",
  reason: "This post recorded no project to resolve against.",
};

const PENDING: OverviewRefResolution = { state: "pending" };

function pathResolution(
  verdict: PathVerdict,
  target: string,
): OverviewRefResolution {
  switch (verdict.state) {
    case "confirmed":
      return {
        state: "actionable",
        payload: verdict.isDir
          ? { kind: "directory", path: verdict.canonical }
          : { kind: "file-path", path: verdict.canonical },
      };
    case "pending":
      return PENDING;
    case "missing":
      return { state: "inert", reason: `Nothing on disk at ${target}.` };
    case "unknown":
      return { state: "inert", reason: "Couldn't verify this path." };
  }
}

/**
 * Resolve one ref against its post's root. Session refs never come here —
 * the session citation owns its own gesture, verdicts and all.
 */
export function resolveOverviewRef(
  ref: OverviewRef,
  root: OverviewRefRoot | null,
  resolvers: OverviewRefResolvers = PRODUCTION_RESOLVERS,
): OverviewRefResolution {
  const target = ref.target;
  if (target.length === 0) {
    return { state: "inert", reason: "This ref names nothing." };
  }
  if (ref.kind === "commit") {
    if (root === null) return NO_ROOT;
    const verdict = resolvers.lookupCommit(root, target);
    if (verdict === null) return NO_ROOT;
    switch (verdict.state) {
      case "confirmed":
        return {
          state: "actionable",
          payload: {
            kind: "commit-sha",
            sha: target,
            root: root.projectDir,
            paths: verdict.paths,
          },
          // A trailing chip stands with no sentence around it, so the hover
          // is the only thing that can say which change this is.
          facts: verdict.facts,
        };
      case "pending":
        return PENDING;
      case "missing":
        return {
          state: "inert",
          reason: `Not a commit in ${root.projectDir}.`,
        };
      case "unknown":
        return { state: "inert", reason: "Couldn't verify this commit." };
    }
  }
  if (ref.kind === "session") {
    return { state: "inert", reason: "A session ref renders as a citation." };
  }
  // file / plan / brief — all file-shaped, resolved by their spelling.
  if (target.startsWith("/")) {
    return pathResolution(resolvers.lookupPath(target, null), target);
  }
  if (root === null) return NO_ROOT;
  if (target.includes("/")) {
    return pathResolution(
      resolvers.lookupPath(target, root.projectDir),
      target,
    );
  }
  const verdict = resolvers.lookupName(root, target);
  if (verdict === null) return NO_ROOT;
  return pathResolution(verdict, target);
}
