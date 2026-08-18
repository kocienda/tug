/**
 * TugSessionIdentity — one session, rendered at a declared density tier.
 *
 * Takes a resolved identity record and a tier, never a format string. Two
 * registers fall out of the tier rather than being chosen: the `chip` tier is
 * a CITATION — a surface referring to a session from foreign context — and
 * wears the session atom, a rounded pill. The `line` tier is PRESENCE — a
 * surface that IS the session — and wears the same identity as bare
 * typography, because on a surface that is the thing, an enclosure reads as a
 * link to it somewhere else.
 *
 * **The mark is a live pulsing dot, and it is the same mark on both registers.**
 * It says what the session is *doing* rather than what kind of thing it is,
 * which is the one thing a static glyph could never do — and it is why the
 * chatbox icon is gone rather than sitting beside it. The dot reads
 * {@link useSessionPhase}, so a session with no reachable live state shows a
 * quiet idle dot rather than a red one.
 *
 * **The title is two runs, not one.** The user's own name leads, then a quieter
 * `:<project>/<callsign>` ({@link sessionTitleParts}). Which run gives way
 * under a width squeeze depends on the register, and both rules are the
 * gallery's: on the atom (the chip tier) the user's own words survive and the
 * minted handle elides — the tooltip and every copy path still carry it whole.
 * On a title surface (the line tier) the same instinct now runs further: the
 * callsign gives way FIRST, and from the middle, so the project prefix and the
 * callsign's last word both survive; the user's name and the bound dash are
 * what the reader keeps.
 * A session with no name renders the bare `<project>/<callsign>`, which may
 * then elide since it is the only run there is. The `project/` prefix rides
 * the callsign run — the project a session works against is how a reader
 * places it — and a session with no known project degrades to the callsign
 * alone.
 *
 * **A dash is a third run, not a badge beside the name.** A dash says where the
 * session is working, which is the same *kind* of fact as the project already
 * riding the callsign — so it joins the grammar rather than competing with the
 * mount site's chrome for a slot. Its loudness inverts with the register for
 * the same reason the elision rules do: on the line tier there is room for the
 * `git-branch` glyph and the dash name, quiet, elided first under a squeeze; on
 * the atom the glyph alone marks it and the name rides the tooltip, because a
 * citation is compact by definition and the binding is temporary while the
 * citation is not. The dash never enters {@link sessionCitation} at all — the
 * flat string outlives the binding in pastes and commits, and one carrying a
 * dash would rot.
 *
 * **The atom paints in text ink.** The pill's run and border take the ordinary
 * text color and a `currentcolor` mix; the dot is its only color channel,
 * because a colored pill around a colored dot was two tints saying one thing.
 *
 * The chip's hover carries the full identity and the citation as a
 * `TugTooltip`, not a placard: `TugTooltip` is explicitly non-interactive and
 * evaporates on any deliberate action, so a button inside one would be
 * unreachable. The acting surface is a right-click instead — the idiom every
 * other Tug chip already uses — and it is the session's whole menu
 * ({@link useSessionIdentityMenu}), not a lone Copy: how to reach the session
 * (Show it, or Resume it where no card holds it), then the two forms the chip
 * can travel as. **Copy as Atom** writes the citation as plain text with the
 * `dev.tug.prompt-atoms` sidecar beside it, so a paste back into a Tug surface
 * returns the chip; **Copy as Citation** writes the flat string alone, for
 * anywhere outside Tug. Both are menu items and neither is a chord: ⌘C is
 * the app's Copy, and what it copies is what the reader selected. The
 * masthead's telemetry placard carries the same citation on a
 * `TugCopyBadge` for a click path.
 *
 * An unresolvable citation keeps its shape — the reader still needs to know
 * what kind of thing is named — takes a dashed border and muted ink, forces its
 * dot to idle, and is fully inert. With the icon gone there is nothing left to
 * slash, so shape alone states the failure, which it already did alongside the
 * slash. Liveness is never a property of a reference: sessions are never dead,
 * only unfindable.
 *
 * Laws: [L02] the dot's phase enters through `useSyncExternalStore`;
 *       [L06] appearance via CSS/DOM, never React state; [L13] motion belongs
 *       to the indicator; [L16] every foreground rule declares its surface;
 *       [L19] component authoring guide; [L20] token sovereignty — composed
 *       children keep their own tokens.
 * Decisions: [D123] one name, produced in one place.
 */

import "./tug-session-identity.css";

import React, { useSyncExternalStore } from "react";
import { EyeOff } from "lucide-react";

import { dispatchCommand } from "@/command-dispatch";
import { DashSigil } from "@/components/tugways/dash-sigil";
import { renderFilterHighlight } from "@/components/tugways/filter-highlight";
import { SessionPhaseDot } from "@/components/tugways/session-phase-dot";
import {
  TugProgressIndicator,
  type TugProgressIndicatorPhaseVisual,
} from "@/components/tugways/tug-progress-indicator";
import { sessionTip } from "@/components/tugways/entity-tips";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { useSessionIdentityMenu } from "@/components/tugways/session-identity-menu";
import { useCardIdForSession } from "@/lib/card-session-binding-store";
import { dashReviewPaints, dashReviewTooltip } from "@/lib/dash-review";
import {
  useDashForSession,
  type DashSessionFact,
} from "@/lib/dash-session-index";
import { sessionSessionPhaseVisual } from "@/lib/code-session-store/session-phase-visual";
import { useCitedSession } from "@/lib/session-citation-store";
import {
  callsignRunParts,
  sessionCitation,
  sessionIdentityLine,
  sessionTitleParts,
  useSessionIdentity,
  type SessionIdentity,
  type SessionIdentityContext,
} from "@/lib/session-identity";
import { sessionPrivateStore } from "@/lib/session-private-store";
import { cn } from "@/lib/utils";

/** Density tiers this component renders. Row and masthead compose these two. */
export type TugSessionIdentityTier = "chip" | "line";

/** Chip sizes. `2xs` is for dense list ink; `sm` is the default. */
export type TugSessionIdentitySize = "sm" | "2xs";

/** The atom's dot box per chip size, in px — a ring box, not a line height. */
const CHIP_DOT_SIZE: Record<TugSessionIdentitySize, number> = {
  sm: 12,
  "2xs": 10,
};

const PHASE_VISUAL: (key: string) => TugProgressIndicatorPhaseVisual =
  sessionSessionPhaseVisual;

/**
 * The line tier's dot, which sits beside body-size text.
 *
 * Exported because a mount site stacking lines UNDER the identity has to know
 * what the mark advances by to start them at the title rather than at the dot —
 * the masthead's description and activity lines do exactly that. One source,
 * two readers.
 */
export const TUG_SESSION_IDENTITY_LINE_DOT_SIZE = 16;

export interface TugSessionIdentityProps
  extends Omit<React.ComponentPropsWithoutRef<"span">, "children" | "onClick"> {
  /** The resolved identity. Never a format string — the tier picks the form. */
  identity: SessionIdentity;
  /**
   * Density tier. `chip` is the citation register (the session atom); `line`
   * is the presence register (bare typography).
   * @selector [data-tier="chip"] | [data-tier="line"]
   * @default "line"
   */
  tier?: TugSessionIdentityTier;
  /**
   * Chip size. Ignored by the line tier, which takes its size from context.
   * @selector [data-size="sm"] | [data-size="2xs"]
   * @default "sm"
   */
  size?: TugSessionIdentitySize;
  /**
   * The citation resolved to nothing — a post or a commit naming a session
   * this ledger has no record of. Chip tier only; makes the atom inert and
   * forces its dot to idle.
   * @selector [data-missing="true"]
   * @default false
   */
  missing?: boolean;
  /**
   * Whether the line tier paints its dot. A mount site whose own row already
   * leads with the session's dot passes `false` rather than showing two.
   * @default true
   */
  dot?: boolean;
  /**
   * A list surface's filter query, painted over the title runs.
   *
   * Applied **per run** — never to a pre-joined string. Joining first would put
   * the ` : ` separator inside a mark and defeat the truncation rule, since the
   * two runs are separately sized. A row that matched on a field it does not
   * display shows no mark, which is the shipped and correct behavior.
   */
  highlight?: string;
  /**
   * The caller's intent for a click on a chip — raise the session's card, or
   * open it. Omitted (or `missing`) leaves the atom inert.
   */
  onOpen?: () => void;
  /**
   * The card this chip is MOUNTED IN, for the menu's go-to item. Only a chip
   * that is a card's own chrome needs to say — a pane's title bar renders
   * above the card host whose context every other mount reads. See
   * {@link SessionIdentityMenuOptions.hostCardId}.
   */
  hostCardId?: string;
  /**
   * Whether hovering the runs shows the identity card.
   *
   * Off where the mount site offers the same facts as a right-click menu. The
   * two were stepping on each other on the row surfaces: the tooltip named the
   * session and its description directly under a row already showing both, and
   * every fact it added — the citation, the lineage — was a thing the reader
   * wanted to ACT on, which a tooltip cannot offer because it is by law
   * non-interactive. The menu can, so where there is a menu the hover is
   * silence. The chip tier keeps it: a citation in a commit line or a Overview
   * post has no row under it to say any of this.
   * @default true
   */
  tooltip?: boolean;
  /**
   * The dash this session is on, when the caller already holds it.
   *
   * {@link SessionDashMarker} otherwise finds it by searching the changeset
   * snapshot for the dash that lists this session — the right shape for a
   * surface that knows only a session id. A surface rendering a specific
   * dash's row already has the answer, and asking the store to re-derive it
   * makes that row's atom depend on a feed having arrived in order to say
   * something the row was built from.
   *
   * `null` is not "no dash": it is "ask the store", which is the default. A
   * caller that means *this session is on no dash* passes nothing, because a
   * session with no dash is what the store already reports.
   */
  dash?: { name: string; review: string | null };
}

/**
 * The Overview-privacy marker: a leaf subscription, composed in beside the runs.
 *
 * A leaf for the same reason the phase dot is one — privacy is not identity, it
 * is a mode the session is in, and folding it into the identity record would
 * wake every identity surface in the app on any session's toggle. It renders
 * nothing at all for a public session, which is every session by default.
 *
 * It has to exist because the state is a **resting** one: `/private`'s ack says
 * the transition happened, and after a reload only a mark on the atom can say
 * the session is still out of the channel.
 */
function SessionPrivacyMarker({
  sessionId,
}: {
  sessionId: string;
}): React.ReactElement | null {
  const isPrivate = useSyncExternalStore(
    sessionPrivateStore.subscribe,
    React.useCallback(
      () => sessionPrivateStore.isPrivate(sessionId),
      [sessionId],
    ),
  );
  if (!isPrivate) return null;
  return (
    <TugTooltip content="Private — kept out of the Overview">
      <span className="tug-session-identity-private" data-slot="session-private">
        <EyeOff aria-label="Private session" />
      </span>
    </TugTooltip>
  );
}

/**
 * The callsign run, in the two spans a middle truncation needs.
 *
 * The line tier elides the callsign before it touches anything else, and it
 * elides it from the MIDDLE — `tugtool/frothy-…nurse-2` keeps both the project
 * a reader places the session by and the word they say it out loud as. CSS
 * cannot cut a run in the middle, so the run arrives pre-cut
 * ({@link callsignRunParts}): a head that ellipsizes and a tail that does not.
 * When the whole run fits, the split is invisible.
 *
 * The filter mark paints inside each half rather than across the pair — a
 * highlight range that straddled the cut would have to be split anyway, and a
 * match spanning an elision is not a match the reader can see.
 */
function CallsignRun({
  callsign,
  highlight,
}: {
  callsign: string;
  highlight: string;
}): React.ReactElement {
  const { head, tail } = callsignRunParts(callsign);
  return (
    <span className="tug-session-identity-callsign">
      {":"}
      <span className="tug-session-identity-callsign-head">
        {renderFilterHighlight(head, highlight)}
      </span>
      {tail.length > 0 ? (
        <span className="tug-session-identity-callsign-tail">
          {renderFilterHighlight(tail, highlight)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The dash marker: a leaf subscription, like {@link SessionPrivacyMarker} and
 * for the same reason. A dash binding is a mode the session is in, not part of
 * its identity, so folding it into the identity record would wake every
 * identity surface in the app whenever any session bound or unbound.
 *
 * Both tiers render the same run — `^<dash-name>` — because the identity is one
 * format wherever it is met. The `^` is the grammar's dash sigil and is
 * decorative to a screen reader, which hears the run's own label instead. The
 * review state paints as a `data-review` attribute the CSS reads ([L06]) — the
 * mark is the run's own tone, since neither register has room for a second
 * mark beside the name.
 */
function SessionDashMarker({
  sessionId,
}: {
  sessionId: string;
}): React.ReactElement | null {
  const dash = useDashForSession(sessionId);
  if (dash === null) return null;
  // The session lookup and the sentence are this component's; the run itself is
  // shared, so the sigil is spelled once for every surface that names a dash.
  return (
    <DashSigil
      name={dash.name}
      review={dash.review ?? null}
      slot="session-identity-dash"
      title={dashMarkerTitle(dash)}
      ariaLabel={`On dash ${dash.name}`}
    />
  );
}

/** One sentence for the dash marker, review state folded in when it paints. */
function dashMarkerTitle(dash: DashSessionFact): string {
  const lead = `Working on dash ${dash.name}`;
  return dashReviewPaints(dash.review)
    ? `${lead} — ${dashReviewTooltip(dash.review!, null)}`
    : lead;
}

/**
 * The hover's dash row — a leaf of its own rather than a value threaded in, so
 * the identity that mounts this does not subscribe to the changeset aggregate
 * just to describe itself. The same reason the marker beside the runs is one.
 *
 * It wears `entity-tips`' own meta class, because it is a row in that tip and
 * not a thing this component styles.
 */
function SessionDashTipLine({
  sessionId,
}: {
  sessionId: string;
}): React.ReactElement | null {
  const dash = useDashForSession(sessionId);
  if (dash === null) return null;
  return <span className="tugx-tip-meta">{dashMarkerTitle(dash)}</span>;
}

/**
 * The identity's hover content: what the run cannot show — the description,
 * the lineage, where the session is working, and the citation, which is the
 * flat-text form a reader would paste elsewhere.
 *
 * The rows are {@link sessionTip}'s, because a session is an entity and an
 * entity has one hover wherever it is pointed at (`entity-tips.tsx`). This
 * once drew its own rows in its own class names — the same rows in the same
 * order, one bubble variant narrower — so a session and the commit beside it
 * described themselves in two different shapes.
 */
function identityTooltip(identity: SessionIdentity): React.ReactNode {
  return sessionTip({
    identityLine: sessionIdentityLine(identity),
    description: identity.description,
    lineage: identity.lineage,
    citation: sessionCitation(identity, { project: true }),
    // A leaf, so the surface holding this identity does not subscribe to the
    // changeset aggregate just to be able to describe itself.
    extra: <SessionDashTipLine sessionId={identity.id} />,
  });
}

export const TugSessionIdentity = React.forwardRef<
  HTMLSpanElement,
  TugSessionIdentityProps
>(function TugSessionIdentity(
  {
    identity,
    tier = "line",
    size = "sm",
    missing = false,
    dot = true,
    highlight = "",
    onOpen,
    hostCardId,
    tooltip = true,
    dash,
    className,
    ...rest
  },
  ref,
) {
  const isChip = tier === "chip";
  const isMissing = isChip && missing;
  // Inert when the citation resolves to nothing, and when the caller has no
  // intent to offer. Both are the same rendering: no cursor, no handler.
  const interactive = isChip && !isMissing && onOpen !== undefined;
  const title = sessionTitleParts(identity);
  const dotSize = isChip
    ? CHIP_DOT_SIZE[size]
    : TUG_SESSION_IDENTITY_LINE_DOT_SIZE;

  // A chip's click is its own, not the row's. Every citation surface mounts
  // this inside a click-hit region that expands a commit or a file, so the
  // click has to stop there or raising a session would fold the row under it —
  // the same guard the rows' trailing accessories already carry.
  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLSpanElement>) => {
      event.stopPropagation();
      onOpen?.();
    },
    [onOpen],
  );

  // Right-click → the session's own menu: how to GET to the session, then the
  // two copies an atom can be (the sidecar-carrying atom, and the flat
  // citation for anywhere outside Tug) and its id. The same hook the row
  // surfaces mount, so a session answers one menu wherever it is shown — the
  // chip carries no description or activity of its own, so those two items are
  // absent here rather than permanently dead.
  const {
    ref: menuRef,
    onContextMenu: openMenu,
    contextMenu,
  } = useSessionIdentityMenu({ identity, hostCardId, enabled: isChip });
  const composedRef = React.useCallback(
    (el: HTMLSpanElement | null): void => {
      menuRef(el);
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLSpanElement | null>).current = el;
    },
    [menuRef, ref],
  );

  const body = (
    <span
      ref={composedRef}
      className={cn("tug-session-identity", className)}
      data-slot="tug-session-identity"
      data-tier={tier}
      data-size={isChip ? size : undefined}
      data-missing={isMissing ? "true" : undefined}
      data-interactive={interactive ? "true" : undefined}
      onClick={interactive ? handleClick : undefined}
      onContextMenu={isChip ? openMenu : undefined}
      {...rest}
    >
      {isChip || dot ? (
        <span className="tug-session-identity-dot">
          {isMissing ? (
            // Forced idle: a reference the ledger cannot find has no liveness
            // to report, and there is no binding to read one from either.
            <TugProgressIndicator
              variant="pulsing-dot"
              size={dotSize}
              phase="idle"
              phaseVisual={PHASE_VISUAL}
              aria-hidden
            />
          ) : (
            <SessionPhaseDot sessionId={identity.id} size={dotSize} />
          )}
        </span>
      ) : null}
      {/* One run holding the whole grammar — `name:project/callsign#dash`.
          The name and callsign are boxed together so the tier's truncation
          rule can pick which of the two elides, and so the box as a whole can
          be clamped rather than shrunk beside the dash. The filter mark is
          painted inside each run, never across two.

          A citation that resolved to nothing has no live binding to report:
          the ledger does not hold the session, so it holds no dash for it
          either. Same rule as the privacy marker below. */}
      <span className="tug-session-identity-run">
        <span className="tug-session-identity-title">
          <span className="tug-session-identity-name">
            {renderFilterHighlight(title.name, highlight)}
          </span>
          {title.callsign !== null ? (
            <CallsignRun callsign={title.callsign} highlight={highlight} />
          ) : null}
        </span>
        {/* The bound dash is part of the identity wherever the identity is
            met — a session on a dash is never named without it, so there is
            deliberately no prop to turn this run off. */}
        {isMissing ? null : dash !== undefined ? (
          <DashSigil
            name={dash.name}
            review={dash.review}
            slot="session-identity-dash"
            title={`Working on dash ${dash.name}`}
            ariaLabel={`On dash ${dash.name}`}
          />
        ) : (
          <SessionDashMarker sessionId={identity.id} />
        )}
      </span>
      {isMissing ? null : <SessionPrivacyMarker sessionId={identity.id} />}
    </span>
  );

  const tipped = !tooltip ? (
    body
  ) : isMissing ? (
    // The tooltip carries the sentence, not the tag — repeating a name the
    // reader can already see says nothing about why it did not resolve.
    <TugTooltip content="Session not found">{body}</TugTooltip>
  ) : (
    <TugTooltip variant="entity" align="start" content={identityTooltip(identity)}>
      {body}
    </TugTooltip>
  );

  if (!isChip) return tipped;
  return (
    <>
      {tipped}
      {contextMenu}
    </>
  );
});

/**
 * A citation chip resolved from a session **id** — the shape every foreign
 * surface wants.
 *
 * The Overview's refs, the Changes card's orphan hint, and the History card's
 * commit line all hold an id and nothing else, and all three have to answer
 * the same question before they can render: does the ledger hold that session?
 * Answering it three times would mean three answers, so it is answered once,
 * here — and it is answered by the **ledger**, over `resolve_sessions`, rather
 * than by whatever this run's caches happened to accumulate. A commit's chip
 * must not be resolvable or slashed depending on whether the picker was opened.
 *
 * Three renderings, one per state of that answer:
 *
 * - **Resolved** — the atom with its live dot, the ledger's own callsign, and
 *   the caller's click intent live.
 * - **Unresolvable** — the dashed inert atom with a forced idle dot, still
 *   showing whatever callsign the commit recorded (`recordedTag`), because a
 *   reference that cannot be followed is more useful naming what it named than
 *   showing a bare hash. Note what this does NOT test: liveness. A closed
 *   session resolves; a commit from another machine does not. Sessions are never
 *   dead, only unfindable.
 * - **Pending** — the round trip is in flight. Inert, and *not* dashed:
 *   claiming "not found" before asking would be the same lie in the other
 *   direction, and the chip is unclickable until it knows where a click goes.
 *
 * **The click is this component's, not the caller's.** Every citation means the
 * same thing by a click — raise the card showing that session — so the gesture
 * lives here rather than being re-passed by each surface, and it is *offered*
 * only when there is a card to raise. A resolved session with no card open is a
 * real and ordinary state; a chip that looked clickable and did nothing in it
 * would be the failure the Overview's disabled refs were written to avoid.
 */
export function TugSessionCitation({
  citedId,
  recordedTag,
  context,
  size = "2xs",
  className,
}: {
  /**
   * What the citation named: a full tug session id, or the 8-char short id a
   * commit trailer records. The ledger expands the short form.
   */
  citedId: string;
  /**
   * The callsign the citation itself recorded, when the caller read one. Shown
   * only if the ledger has no callsign of its own, and never taken as evidence
   * that the session is findable.
   */
  recordedTag?: string | null;
  /** Further facts the caller already holds — a row's state or lineage. */
  context?: SessionIdentityContext;
  size?: TugSessionIdentitySize;
  className?: string;
}): React.ReactElement {
  const cited = useCitedSession(citedId);
  // Once the ledger answers, its row is the identity's context — a citation has
  // no card binding to borrow a project dir from, so without this a resolvable
  // session would render its callsign with no project in front of it.
  const sessionId = cited.status === "found" ? cited.sessionId : citedId;
  const identity = useSessionIdentity(sessionId, {
    ...context,
    recordedTag: recordedTag ?? context?.recordedTag ?? null,
    ...(cited.status === "found"
      ? {
          projectDir: context?.projectDir ?? cited.projectDir,
          state: context?.state ?? cited.state,
          tagLineage: context?.tagLineage ?? cited.tagLineage,
          ledgerKnown: true,
        }
      : {}),
  });
  const pending = cited.status === "pending" && !identity.resolved;
  const missing = !pending && !identity.resolved;
  // Subscribed, so the click appears when the session's card opens and goes
  // away when it closes, with no repaint of the surrounding surface needed.
  const cardId = useCardIdForSession(sessionId);
  const canRaise = !missing && !pending && cardId !== null;
  return (
    <TugSessionIdentity
      identity={identity}
      tier="chip"
      size={size}
      missing={missing}
      // The raise rides the registry's own `focus-session-card` — the same
      // funnel the Lens rows dispatch — so a chip's click and a row's click
      // cannot drift into two raises ([L30]).
      onOpen={
        canRaise
          ? () => dispatchCommand("focus-session-card", { cardId })
          : undefined
      }
      className={className}
    />
  );
}