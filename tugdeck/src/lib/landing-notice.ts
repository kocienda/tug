/**
 * landing-notice — what a landing surface should be saying right now ([L31]).
 *
 * The face is what a landing surface renders: two independent notices, each
 * carrying a cause in the user's frame, the remedy, and git's own words to
 * fold. The strip that renders it is `session-landing-notice-strip.tsx`; this
 * module decides the words and the identity, and nothing about visibility.
 *
 * The words are separated from the surface that renders them because the
 * surface is a React component with no substrate to test against, while the
 * words are the part that can be wrong: which of two competing conditions
 * speaks, what a given stderr means, whether a repeat press speaks again.
 * Keeping it a pure function over what the mode published makes those
 * answerable without a DOM, and leaves the component with nothing to decide.
 *
 * @module lib/landing-notice
 */

import type { LandingKind, LandingSnapshot } from "@/lib/landing-mode";

/** One notice a landing surface can render — the words plus its identity. */
export interface LandingNotice {
  /** Identity for local dismiss / fade: the detail string for an error, `String(seq)` for a refusal. */
  key: string;
  channel: "error" | "refusal";
  tone: "danger" | "caution";
  title: string;
  /** The remedy sentence, or the refusal's sentence. */
  remedy: string;
  /** Verbatim detail to fold, or null when there is nothing beyond the title. */
  detail: string | null;
  /** Whether Retry applies — true only for the error channel. */
  retry: boolean;
}

/** Both channels at once, because both can be true ([P02]). */
export interface LandingNoticeFace {
  error: LandingNotice | null;
  refusal: LandingNotice | null;
}

/** One row of the cause table — a match over the lowercased detail, and what to say. */
interface CauseRow {
  match: (lower: string) => boolean;
  title: string;
  remedy: string;
}

const KEPT = "try again — your message is kept.";

/**
 * The causes git actually produces, in the order they are tried (Table T01).
 *
 * Substring matching over the whole detail, case-insensitively, first row wins.
 * A row's title names the cause in the user's frame and its remedy names the
 * one thing to do; git's own text is never thrown away, it is folded.
 */
const COMMIT_CAUSES: CauseRow[] = [
  {
    match: (lower) => lower.includes("index.lock") && lower.includes("exists"),
    title: "Another git process is holding the repository lock",
    remedy: `Tug couldn't take .git/index.lock. If nothing else is running git here, remove the lock file and ${KEPT}`,
  },
  {
    match: (lower) =>
      lower.includes("please tell me who you are") ||
      lower.includes("author identity unknown") ||
      lower.includes("empty ident name"),
    title: "Git doesn't know who you are yet",
    remedy: `Set user.name and user.email with git config, then ${KEPT}`,
  },
  {
    match: (lower) =>
      lower.includes("hook") &&
      (lower.includes("failed") ||
        lower.includes("declined") ||
        lower.includes("rejected") ||
        lower.includes("exit code")),
    title: "A commit hook refused the commit",
    remedy: "Read the hook's output below, fix what it names, and try again.",
  },
  {
    match: (lower) =>
      lower.includes("nothing to commit") || lower.includes("no changes added to commit"),
    title: "Nothing left to commit",
    remedy:
      "These files were already committed — likely by another session. Close the shade and check the transcript.",
  },
  {
    match: (lower) => lower.includes("hunk drift:"),
    title: "The hunks you picked have moved",
    remedy:
      "The file changed under your selection. Reopen the Changes shade, pick the hunks again, and try again.",
  },
  {
    match: (lower) => lower.includes("already staged"),
    title: "Some files are already staged",
    remedy: `Picking hunks commits the whole index, so Tug won't commit while other files sit in it. Unstage them with git reset, or commit whole files instead of picking hunks, and ${KEPT}`,
  },
];

/** git's first line, with the prefix that names a severity the title doesn't need. */
function firstLine(detail: string): string {
  const line = detail.split("\n", 1)[0]?.trim() ?? "";
  return line.replace(/^(?:fatal|error):\s*/i, "");
}

/**
 * What a landing failure means, and what to do about it.
 *
 * The evidence is always kept: `detail` comes back verbatim so the surface can
 * fold it, and goes null only when folding it would show the title a second
 * time. A commit detail that matches no row falls back to git's own first line
 * as the title, which is worse prose than a translated row and still better
 * than "Commit failed" — the fallback is what makes the table extensible
 * without a gap in the meantime. A join detail is always its first line: the
 * engine's refusals are already sentences in the user's frame ([P01]).
 */
export function describeLandingFailure(
  kind: LandingKind,
  detail: string,
): { title: string; remedy: string; detail: string | null } {
  const lower = detail.toLowerCase();
  const row =
    kind === "commit" ? COMMIT_CAUSES.find((candidate) => candidate.match(lower)) : undefined;

  const title = row ? row.title : firstLine(detail);
  const remedy = row
    ? row.remedy
    : kind === "commit"
      ? `Read git's message below, fix what it names, and ${KEPT}`
      : `Fix what it names and ${KEPT}`;

  const spent = !detail.includes("\n") && detail.trim() === title;
  return { title, remedy, detail: spent ? null : detail };
}

/**
 * The two notices a landing mode is publishing right now.
 *
 * `active` is not read here — the strip gates on it. That keeps this function
 * about words and identity, and leaves the visibility rule in one place.
 *
 * Refusals are keyed on `seq`, never on the sentence: pressing a refusing
 * button twice usually produces the identical words, and a surface that
 * compared text would go silent exactly when the user asked a second time. An
 * error is keyed on its detail for the same reason inverted — the same failure
 * settling twice is the same notice, and a dismiss of it should hold.
 */
export function landingNoticeFace(kind: LandingKind, snapshot: LandingSnapshot): LandingNoticeFace {
  const noun = kind === "commit" ? "Commit" : "Join";

  const failure = snapshot.landError;
  const error: LandingNotice | null =
    failure === null
      ? null
      : {
          key: failure,
          channel: "error",
          tone: "danger",
          retry: true,
          ...describeLandingFailure(kind, failure),
        };

  const refused = snapshot.landRefusal;
  const refusal: LandingNotice | null =
    refused === null
      ? null
      : {
          key: String(refused.seq),
          channel: "refusal",
          tone: refused.kind === "fault" ? "danger" : "caution",
          title: refused.kind === "fault" ? `${noun} cannot run` : `${noun} not sent`,
          remedy: refused.sentence,
          detail: null,
          retry: false,
        };

  return { error, refusal };
}
