/**
 * session-identity.ts — the one place Tug decides what a session is called.
 *
 * Tug used to name a session five different ways: a chip rule, a chooser-row
 * rule, a card-row hash sniff, a title-bar composer, and the Rust feed's own
 * precedence. No two agreed. This module is [D123] ("a pane's name is one
 * string produced in one place") applied to the session: one resolver produces
 * one structured {@link SessionIdentity} record, and every surface renders that
 * record at a declared density tier.
 *
 * Three entry points, and which one you want is not a matter of taste:
 *
 *  - {@link useSessionIdentity} — **the React entry point.** It subscribes to
 *    each backing store *by id* and then derives. Every component uses this.
 *  - {@link resolveSessionIdentity} — an imperative SNAPSHOT with no
 *    subscription. Correct only for non-React callers: clipboard writes,
 *    export filenames, command routes, list projections that already carry
 *    the stores' version tokens as inputs.
 *  - {@link sessionIdentityLine} / {@link sessionCitation} — pure formatters
 *    over a resolved record.
 *
 * **Calling the bare resolver from a render is the bug this module exists to
 * prevent.** It reads three stores imperatively; from a render body it hands
 * back a snapshot with no subscription, so a `/rename` or a synopsis write
 * updates the stores while the surface repaints never. That failure passes
 * every unit test and shows up only as a stale name in the running app, which
 * is why "no component calls `resolveSessionIdentity`" is a grep gate rather
 * than a convention.
 *
 * **Liveness is not identity.** The record carries no phase field. Phase lives
 * on a per-*card* `codeSessionStore`, and folding it in would wake every
 * identity surface on every transcript event. `useSessionPhase` is the
 * session-keyed door onto it, returning a short key rather than the snapshot,
 * and the phase dot stays a leaf subscription composed *into* the chip, row, and
 * masthead tiers as a child; identity and liveness are two subscriptions with
 * two keys that meet in the component.
 *
 * **The branch is not identity either.** It is telemetry — it rides the record
 * for the masthead's placard and never appears in a rendered name. The old
 * `(<branch>)` title suffix is retired.
 *
 * **Resolvability is a field, not an inference from `tag`.** A citation may name
 * a session this ledger has never held, and the honest rendering still shows the
 * callsign that citation recorded ([P13]) — so `tag` alone cannot answer "can
 * this be found", and {@link SessionIdentity.resolved} does. Whether the ledger
 * holds a cited session is asked over the wire by
 * `session-citation-store.ts`; this module only records the answer.
 *
 * Laws: [L02] external state enters React through `useSyncExternalStore` only.
 *
 * @module lib/session-identity
 */

import { useCallback, useSyncExternalStore } from "react";

import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "@/lib/card-session-binding-store";
import { sessionNameStore } from "@/lib/session-name-store";
import { sessionSynopsisStore } from "@/lib/session-synopsis-store";
import { sessionTagStore } from "@/lib/session-tag-store";
import {
  identityKeyForSession,
  sessionLineStore,
} from "@/lib/session-line-store";
import type { SessionRow } from "@/protocol";

/** Chars of a session UUID that make its short id. Computed here and nowhere else. */
export const SESSION_SHORT_ID_LENGTH = 8;

/**
 * One session's identity, as every surface in the app reads it.
 *
 * Deliberately absent: phase/liveness (a per-card subscription, composed in as
 * a child) and anything a caller would have to re-derive.
 */
export interface SessionIdentity {
  /** Project leaf name (basename of projectDir); `""` when the project is unknown. */
  project: string;
  /** Workspace branch, or null — telemetry only, never rendered in identity. */
  branch: string | null;
  /** The callsign; null only for a legacy tagless row. Stable for the life
   *  of the line of work — a rewind-fork inherits it by transfer. */
  tag: string | null;
  /**
   * The user's own name for this session — `/rename`, never an auto title.
   *
   * Independent of {@link description}, and never merged with it: the name is
   * the title a surface leads with ({@link sessionTitleParts}) and the
   * description is the line beneath it. A single merged field could serve
   * neither.
   */
  customName: string | null;
  /** The agent's rolling description. Independent of {@link customName}. */
  description: string | null;
  /** Ledger state, when the caller knows it. */
  state: SessionRow["state"] | null;
  /** Full tug session id (plumbing: tooltips, copy affordance). */
  id: string;
  /** First {@link SESSION_SHORT_ID_LENGTH} chars of `id` — THE short id. */
  shortId: string;
  /**
   * Whether this identity is the LEDGER's word about a session it actually
   * holds, as against a reference reconstructed from what a commit recorded.
   *
   * This is the resolvable/unresolvable distinction, and it has to live on the
   * record because `tag` cannot carry it: {@link SessionIdentityContext.recordedTag}
   * fills the callsign for a citation the ledger has never heard of, precisely
   * so an unresolvable reference can still say what it named ([P13]). A reader
   * of `tag` alone therefore cannot tell the two apart, and one that tried
   * would call every foreign commit's session findable.
   *
   * `true` when some ledger-fed source named this session: a callsign in the
   * tag store, a card binding supplying its project, or a `resolve_sessions`
   * answer. Note what it is NOT: liveness. A closed session is resolved; a
   * commit from another machine is not. Sessions are never dead, only
   * unfindable ([P13], [P15]).
   */
  resolved: boolean;
}

/**
 * The facts about a session that do NOT live in the three by-id identity
 * stores, supplied by a caller that already holds them.
 *
 * The picker and the Cards card hold a whole `SessionRow` and pass it through
 * {@link sessionIdentityContextFrom}; the Session card and the masthead pass
 * their project dir and (for the placard) the branch. Anything omitted
 * resolves to its honest empty value rather than being invented — except
 * `projectDir`, which falls back to the session's card binding when one
 * exists.
 */
export interface SessionIdentityContext {
  projectDir?: string | null;
  branch?: string | null;
  state?: SessionRow["state"] | null;
  /**
   * A callsign recorded **elsewhere**, at write time — the tag inside a commit's
   * `Tug-Session:` trailer. Used only when this ledger has none of its own, so
   * the ledger stays authoritative and a rerolled callsign is never overruled by
   * an older commit's copy of it.
   *
   * It exists because a citation can be unresolvable and still informative: a
   * commit made on another machine names a session this ledger has no record of,
   * and the honest rendering is the callsign that commit actually recorded,
   * slashed and inert ([P13]), rather than a bare hash the commit never said.
   *
   * It fills `tag` and deliberately does **not** touch
   * {@link SessionIdentity.resolved} — that separation is the whole point. A
   * recorded callsign is what the reference *said*, never evidence that this
   * ledger can find what it named.
   */
  recordedTag?: string | null;
  /**
   * A project leaf-name recorded **elsewhere** — the `<project>` head of a
   * session atom's `<project>/<callsign>` value. The same contract as
   * {@link recordedTag}, for the other half of the reference: it fills
   * {@link SessionIdentity.project} only when no ledger-fed source supplies a
   * project dir, and it never makes the identity
   * {@link SessionIdentity.resolved} — what a reference recorded is what it
   * said, never evidence that this ledger can find what it named.
   */
  recordedProject?: string | null;
  /**
   * The ledger's own answer that it holds this session, from a
   * `resolve_sessions` round trip (`session-citation-store.ts`).
   *
   * A citation surface has no card binding and may sit outside any listing, so
   * without this the two local signals would call every foreign commit's
   * session unfindable — and every locally-known one findable only by accident
   * of what had been listed. Omitted by callers who hold no such answer, which
   * leaves resolvability to those local signals exactly as before.
   */
  ledgerKnown?: boolean;
}

/**
 * The trailing path component (basename) of a directory: the project's
 * leaf-name identity. Trailing slashes are ignored; an empty or slash-only
 * path yields the trimmed input.
 */
export function projectLeafName(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  const leaf = trimmed.split("/").pop() ?? "";
  return leaf.length > 0 ? leaf : trimmed;
}

/** The short id: the first {@link SESSION_SHORT_ID_LENGTH} chars of the UUID. */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, SESSION_SHORT_ID_LENGTH);
}

/**
 * Compose an identity record from explicit facts — the pure half, with no
 * store reads. This is what the unit tests exercise; {@link resolveSessionIdentity}
 * is this function with the three stores read for it.
 */
export function composeSessionIdentity(input: {
  sessionId: string;
  name: string | null;
  synopsis: string | null;
  /** The callsign THIS LEDGER holds for the session, or null. */
  tag: string | null;
  /**
   * The callsign a commit recorded, used only when the ledger has none. It
   * fills `tag` without making the identity {@link SessionIdentity.resolved} —
   * see the field's own note.
   */
  recordedTag?: string | null;
  /**
   * A project leaf-name the reference recorded. Fills `project` only when
   * `projectDir` supplies none, and never affects `resolved` — see the
   * context field's own note.
   */
  recordedProject?: string | null;
  projectDir?: string | null;
  branch?: string | null;
  state?: SessionRow["state"] | null;
  /** The ledger's explicit answer that it holds this session. */
  ledgerKnown?: boolean;
}): SessionIdentity {
  const ledgerTag = input.tag?.trim() || null;
  const recordedTag = input.recordedTag?.trim() || null;
  const tag = ledgerTag ?? recordedTag;
  const name = input.name?.trim() || null;
  const synopsis = input.synopsis?.trim() || null;
  const projectDir = input.projectDir?.trim() ?? "";
  const recordedProject = input.recordedProject?.trim() || null;
  const branch = input.branch?.trim() || null;
  return {
    project:
      projectDir.length > 0
        ? projectLeafName(projectDir)
        : (recordedProject ?? ""),
    branch,
    tag,
    // Resolvability rests only on ledger-fed facts. `recordedTag` is
    // conspicuously absent from this expression: a commit's own copy of a
    // callsign tells the reader what was named, never that it can be found.
    resolved:
      input.ledgerKnown === true || ledgerTag !== null || projectDir.length > 0,
    // Two fields, never a fallback between them: they occupy different lines on
    // every surface. The name store holds only user-set names, so an auto title
    // can never arrive here as a `customName`.
    customName: name,
    description: synopsis,
    state: input.state ?? null,
    id: input.sessionId,
    shortId: shortSessionId(input.sessionId),
  };
}

/** The context a `SessionRow` supplies — the picker's and the Cards card's path in. */
export function sessionIdentityContextFrom(
  row: SessionRow,
): SessionIdentityContext {
  return {
    projectDir: row.project_dir,
    state: row.state,
  };
}

/** The project dir of whichever card is bound to `sessionId`, or null. */
function boundProjectDirFor(sessionId: string): string | null {
  const lineId = sessionLineStore.lineOf(sessionId);
  for (const binding of cardSessionBindingStore.getSnapshot().values()) {
    if (binding.tugSessionId === sessionId) return binding.projectDir;
    if (lineId !== null && binding.lineId === lineId) return binding.projectDir;
  }
  return null;
}

/**
 * Resolve a session's identity **as a snapshot, with no subscription**.
 *
 * Non-React callers only — clipboard writes, export filenames, command routes,
 * and list projections that already carry the identity stores' version tokens
 * as recompute inputs. Every component uses {@link useSessionIdentity} instead;
 * calling this from a render is the stale-render bug this module's header
 * describes, and a grep gate exists to keep it out of `components/`.
 */
export function resolveSessionIdentity(
  sessionId: string,
  context?: SessionIdentityContext,
): SessionIdentity {
  // The name, the callsign and the synopsis belong to the **line** ([P12]) —
  // the segment id is only the address the caller happens to hold.
  const lineId = identityKeyForSession(sessionId);
  return composeSessionIdentity({
    sessionId,
    name: sessionNameStore.getName(lineId),
    synopsis: sessionSynopsisStore.getSynopsis(lineId),
    tag: sessionTagStore.getTag(lineId),
    recordedTag: context?.recordedTag ?? null,
    recordedProject: context?.recordedProject ?? null,
    projectDir: context?.projectDir ?? boundProjectDirFor(sessionId),
    branch: context?.branch ?? null,
    state: context?.state ?? null,
    ledgerKnown: context?.ledgerKnown ?? false,
  });
}

/**
 * The React entry point: subscribe to each backing store **by id**, then
 * resolve. Returns null for a null `sessionId` so a caller with no session
 * needs no branch of its own.
 *
 * By-id getters, deliberately: the stores also publish whole-store version
 * tokens, but those exist for consumers deriving across many sessions at once
 * (the Cards card's filter projection). Reading a version token here would wake every
 * identity surface in the app on any session's rename.
 *
 * Overloaded on the argument, so a caller that already holds a session id gets
 * a record rather than a maybe-record and writes no branch for a state its own
 * types forbid. The nullable arm exists for callers whose binding may not have
 * resolved yet.
 */
export function useSessionIdentity(
  sessionId: string,
  context?: SessionIdentityContext,
): SessionIdentity;
export function useSessionIdentity(
  sessionId: string | null,
  context?: SessionIdentityContext,
): SessionIdentity | null;
export function useSessionIdentity(
  sessionId: string | null,
  context?: SessionIdentityContext,
): SessionIdentity | null {
  // The line the segment belongs to, subscribed like the rest: a rotation
  // re-keys this card's identity, and a hook that read the mapping
  // unsubscribed would keep resolving under the id the card has left.
  const lineId = useSyncExternalStore(
    sessionLineStore.subscribe,
    useCallback(
      () => (sessionId === null ? null : identityKeyForSession(sessionId)),
      [sessionId],
    ),
  );
  const name = useSyncExternalStore(
    sessionNameStore.subscribe,
    useCallback(
      () => (lineId === null ? null : sessionNameStore.getName(lineId)),
      [lineId],
    ),
  );
  const tag = useSyncExternalStore(
    sessionTagStore.subscribe,
    useCallback(
      () => (lineId === null ? null : sessionTagStore.getTag(lineId)),
      [lineId],
    ),
  );
  const synopsis = useSyncExternalStore(
    sessionSynopsisStore.subscribe,
    useCallback(
      () =>
        lineId === null
          ? null
          : sessionSynopsisStore.getSynopsis(lineId),
      [lineId],
    ),
  );
  // The project dir a caller did not supply. The snapshot is the dir STRING,
  // not the binding, so React bails out on every binding change that does not
  // move this session's project — which is all of them but a rebind.
  const boundProjectDir = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    useCallback(
      () => (sessionId === null ? null : boundProjectDirFor(sessionId)),
      [sessionId],
    ),
  );
  if (sessionId === null) return null;
  return composeSessionIdentity({
    sessionId,
    name,
    synopsis,
    tag,
    recordedTag: context?.recordedTag ?? null,
    recordedProject: context?.recordedProject ?? null,
    projectDir: context?.projectDir ?? boundProjectDir,
    branch: context?.branch ?? null,
    state: context?.state ?? null,
    ledgerKnown: context?.ledgerKnown ?? false,
  });
}

/**
 * The two runs a surface renders as a session's title.
 *
 * **A custom name means no callsign, full stop.** A user-supplied name is the
 * user saying what the session is called, and the name REPLACES the callsign
 * rather than leading it: showing both harmed legibility and made the title
 * too long for the interface beside it. The callsign stays the permanent
 * citable handle — the tooltip, the citation, and every copy path carry it
 * whole — it just never rides the title.
 *
 * There is no collision exception, because a collision can no longer occur:
 * a user-set name is unique across lines at the write, and a name another line
 * already wears is TAKEN from it by the newer `/rename` — the previous holder
 * falls back to its callsign ([D167]). Uniqueness at the write is what retired
 * the exception; the callsign the reader would have needed to disambiguate
 * with is a callsign there is nothing to disambiguate.
 *
 * With no name at all, the callsign IS the title and there is no second run.
 * The `callsign` run therefore appears only for an unnamed session, which is
 * also why it carries the `project/` prefix — `tugtool/frothy-nurse` — the
 * project a session works against being how a reader places it in a list of
 * sessions from many projects. The composed run is exactly
 * {@link sessionIdentityLine}, so the title and the Line channel cannot spell
 * the same session two ways.
 *
 * Two runs rather than one joined string, because they are sized separately.
 * The `":"` separator belongs to the callsign run so it disappears with it.
 */
export function sessionTitleParts(identity: SessionIdentity): {
  name: string;
  callsign: string | null;
} {
  return {
    name: identity.customName ?? sessionIdentityLine(identity),
    callsign: null,
  };
}

/**
 * The same title as ONE string, for a surface that cannot size two runs.
 *
 * {@link sessionTitleParts} exists because a measured surface wants to decide
 * which run gives way. A flat row, a baked chip, and an aria label have one
 * string and one truncation, and they still owe the reader the same rule — so
 * the join lives here rather than being spelled at each call site, where the
 * three would eventually disagree about how the two runs meet.
 *
 * The separator is the one the two-run form renders, and it belongs to the
 * callsign exactly as it does there: no callsign, no separator. Under the
 * unconditional rule there is never a second run, so this is the name for a
 * named session and the identity line for an unnamed one.
 */
export function sessionDisplayTitle(identity: SessionIdentity): string {
  const { name, callsign } = sessionTitleParts(identity);
  return callsign === null ? name : `${name}:${callsign}`;
}

/**
 * The Line-tier string: `<project>/<callsign>`.
 *
 * No branch suffix and no name arm — which is what makes this string
 * **constant for the life of a session binding**, and that is load-bearing
 * rather than incidental. The pane-title channel carries it for reader
 * compatibility (the tab strip, the Window menu, the slot-stack picker); it is
 * not a notification path, and identity changes reach surfaces through
 * {@link useSessionIdentity}. A legacy tagless session degrades to its short
 * id — never the full UUID.
 */
export function sessionIdentityLine(identity: SessionIdentity): string {
  const label = identity.tag ?? identity.shortId;
  return identity.project.length > 0
    ? `${identity.project}/${label}`
    : label;
}

/**
 * The citation — the only sanctioned flat-text form of a session reference,
 * and the only place monospace appears: `<tag> (<shortId>)`, project-prefixed
 * when the surrounding context does not supply the project.
 *
 * A legacy tagless session degrades to the bare short id with no parentheses:
 * the hash is already the callsign there, and printing it twice is noise.
 */
export function sessionCitation(
  identity: SessionIdentity,
  opts?: { project?: boolean },
): string {
  const withProject = opts?.project === true && identity.project.length > 0;
  if (identity.tag === null) {
    return withProject
      ? `${identity.project}/${identity.shortId}`
      : identity.shortId;
  }
  const head = withProject
    ? `${identity.project}/${identity.tag}`
    : identity.tag;
  return `${head} (${identity.shortId})`;
}

/** The parenthesized token of a citation: `<tag> (<token>)`. */
const CITATION_TOKEN = /\(([0-9a-fA-F-]+)\)\s*$/;

/** A full session UUID — the legacy trailer's token, and `Tug-Session-Id`'s. */
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A short id: exactly {@link SESSION_SHORT_ID_LENGTH} hex chars. */
const SHORT_ID = /^[0-9a-f]{8}$/i;

/**
 * What a commit's session trailers name (Spec S03) — the id to resolve against,
 * and the callsign the commit itself recorded.
 */
export interface CitedSession {
  /**
   * The id the commit named, exactly as it named it: a full uuid when it
   * carries one (or a legacy trailer spelled one), else the citation's 8-char
   * short id.
   *
   * A short id is **not** expanded here. Expansion needs a view of every
   * session and the ability to notice that two share a prefix, and only the
   * ledger has both — `session-citation-store.ts` asks it, and hands back the
   * full id. A client-side prefix scan over whatever happened to be cached
   * would answer differently depending on which listings had run.
   */
  citedId: string;
  /** The callsign the trailer recorded, or null for a legacy tagless commit. */
  tag: string | null;
}

/**
 * Resolve a commit's session trailers to the session they name.
 *
 * Precedence per Spec S03, and the order is the point:
 *
 *  1. **`Tug-Session-Id`** — the machine field, a full uuid, an exact join.
 *     Every commit written after the trailer pair shipped carries it.
 *  2. **The citation's parenthesized token.** A 36-char uuid means a *legacy*
 *     one-line trailer (`<display> (<full-uuid>)`), which therefore resolves
 *     exactly too — legacy commits live in history forever and must not degrade
 *     to unresolvable. An 8-hex token is a short id, which the ledger expands.
 *  3. Neither parses → `null`, and the caller renders nothing at all.
 *
 * The callsign is read off the citation's head in both forms. For a legacy
 * trailer that head is a *display name*, not a tag — which is why it is only
 * ever a fallback ({@link SessionIdentityContext.recordedTag}) and never
 * overrules what this ledger says the session is called.
 *
 * Pure grammar: no store reads, so a caller may memoize it on the trailer text
 * alone. Turning the id into a *session* is the citation store's job.
 */
export function resolveCitedSession(
  citation: string | null | undefined,
  sessionId?: string | null,
): CitedSession | null {
  const raw = citation?.trim() ?? "";
  const machineId = sessionId?.trim() ?? "";
  const match = CITATION_TOKEN.exec(raw);
  // The tagless citation form is the bare short id with no parentheses, so a
  // trailer that is nothing but a token IS the token, and carries no callsign.
  const parenthesized = match !== null;
  const head = parenthesized ? raw.slice(0, match.index).trim() : "";
  const token = parenthesized ? match[1] : raw;
  const tag = head.length > 0 ? head : null;

  if (FULL_UUID.test(machineId)) return { citedId: machineId, tag };
  if (FULL_UUID.test(token)) return { citedId: token, tag };
  if (SHORT_ID.test(token)) return { citedId: token.toLowerCase(), tag };
  return null;
}

/**
 * The Line string for a session, resolved and formatted in one call — the
 * non-React shorthand for a list projection or a command route. Components use
 * {@link useSessionIdentity} + {@link sessionIdentityLine} instead.
 */
export function sessionIdentityLineFor(
  sessionId: string,
  context?: SessionIdentityContext,
): string {
  return sessionIdentityLine(resolveSessionIdentity(sessionId, context));
}

/** The Line string for a card's session binding — the Cards card's own projection. */
export function sessionIdentityLineForBinding(
  binding: CardSessionBinding,
): string {
  return sessionIdentityLineFor(binding.tugSessionId, {
    projectDir: binding.projectDir,
  });
}

/**
 * The display title for a card's session binding — the flat-row half of the
 * Cards card's own projection, beside {@link sessionIdentityLineForBinding}.
 *
 * The Cards card needs both and for different jobs: this is what a row SHOWS, the
 * Line is what a filter still MATCHES, so typing a callsign finds a session
 * whose row no longer prints one.
 */
export function sessionDisplayTitleForBinding(
  binding: CardSessionBinding,
): string {
  return sessionDisplayTitle(
    resolveSessionIdentity(binding.tugSessionId, {
      projectDir: binding.projectDir,
    }),
  );
}
