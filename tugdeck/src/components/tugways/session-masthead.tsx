/**
 * SessionMasthead — the three lines a Session card wears in pane chrome.
 *
 *   [dot] <name> : <callsign>     ← identity, and whether it is working
 *   <description>                 ← the agent's synopsis, or a stand-in
 *   <activity>               ~~~  ← the voice, with its activity sparkline
 *
 * Three levels of the same session, widening as they go down: what it IS, what
 * it is FOR, and what it is doing this second.
 *
 * **The three lines are `SessionIdentityRow`'s, not this component's.** The
 * masthead, the Cards card rows, and the new-session picker rows show the same thing,
 * so they wear one authoring of it — not only of the shape but of what goes in
 * it: the identity, the description ladder, the activity ladder, the phase dot,
 * and the tape are all that component's, and this one asks for them at the
 * masthead's settings (the dense dot, sub-lines flush with the title, the tape
 * on, the beat paced and set through the markdown pipeline) ([D132]).
 *
 * What stays local is what is genuinely the masthead's: the two popovers, the
 * telemetry widget, the copy gestures, and the chrome geometry — the row is
 * mounted with its list-row padding zeroed and each of its three lines told
 * what to stop short of, because the pane's control cluster occupies only the
 * FIRST of the tier's three bands.
 *
 * The pane owns the chrome SLOT and its geometry; this component owns what is
 * inside it and every store behind those lines. That split is what keeps
 * session-domain machinery — the beat feed, the activity series, the
 * retired `pulse/enabled` default, the telemetry the popover reports — out of pane
 * code while chrome stays the pane's ([L09]). The precedent is the Session
 * card mounting `TugPaneBanner`: pane-class furniture, session-class content
 * inside it.
 *
 * The pane's whole controls cluster renders over this tier — the slot-stack
 * badge, the `…` section menu, the width control, and the close X — and the
 * summary widget stands IN that row rather than replacing any of them: it is
 * portaled into a host the pane renders directly after the badge, so the pane
 * decides where it sits and this component decides what it says. Beside the
 * cluster rather than in it, it sat ahead of the badge, which leads that row.
 * The width control was suppressed here for a while on the argument that
 * the title row was already identity plus a widget; the Session card is the
 * pane whose width is retuned most often, so that left the control missing from
 * the one surface that most wanted it.
 *
 * Keyed by `sessionId`, which is all the pane knows and all it should: the
 * chrome names a session and this component resolves what to say about it.
 * Identity comes through `useSessionIdentity`, so a rename or a callsign
 * reroll repaints the masthead with no reload and no pane involvement.
 *
 * The masthead never reflows. Every line truncates rather than wrapping, the
 * description line holds its place when empty, and the slot's height is a
 * fixed token — a chrome tier that changed height with its content would move
 * the card beneath it on every beat.
 *
 * The trailing widget opens the telemetry popover: branch, state, turns,
 * stamps, and the citation with a copy affordance. A popover is where the copy
 * lives rather than a hover surface, because a hover-dismissed panel puts its
 * own button out of the pointer's reach — and rather than a `TugPlacard`,
 * which renders in place and needs its caller to own the vertical axis inside
 * a positioned ancestor, a contract a clipping 72px chrome tier cannot honour.
 *
 * Laws: [L02] every store enters through `useSyncExternalStore`;
 *       [L06] appearance via CSS/DOM, never React state;
 *       [L09] chrome is the pane's — the pane mounts this into a slot it owns;
 *       [L19] `.tsx`/`.css` pair with `data-slot`;
 *       [L20] `TugActivityLine` is composed through its published knobs only.
 */

import "./masthead-frame.css";
import "./session-masthead.css";

import React, { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { FolderOpenDot, Summary } from "lucide-react";

import { TugButton } from "@/components/tugways/internal/tug-button";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import {
  TugPopover,
  TugPopoverAnchor,
  TugPopoverContent,
  TugPopoverTrigger,
} from "@/components/tugways/tug-popover";
import {
  TugPopupListEmpty,
  TugPopupListFrame,
  TugPopupListItem,
  TugPopupListItemText,
  TugPopupListScroller,
  TugPopupListToneDot,
} from "@/components/tugways/tug-popup-list";
import { SessionActivityCard } from "@/components/tugways/cards/session-activity-card";
import { useCopyableButton } from "@/components/tugways/use-copyable-text";
import { BlockCopyButton } from "@/components/tugways/body-kinds/affordances";
import { formatByteSize } from "@/components/tugways/cards/session-picker-format";
import { BeatText } from "@/components/tugways/beat-text";
import {
  annotationClaimsClick,
  useAnnotationClicks,
} from "@/components/tugways/use-annotation-clicks";
import { parseBeatFileTarget } from "@/lib/beat-line/beat-file-target";
import { renderBeatLine } from "@/lib/beat-line/render-beat-line";
import { formatRestingStamp } from "@/lib/session-activity-line";
import { useSessionPhase } from "@/lib/code-session-store/use-session-phase";
import { SESSION_PHASE_LABELS } from "@/lib/code-session-store/session-phase-visual";
import { useSessionCreatedAtMs } from "@/lib/session-created-at";
import { writeSessionAtomToClipboard } from "@/lib/session-atom";
import { openPathInOS } from "@/lib/os-open";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import { SessionIdentityRow } from "@/components/tugways/session-identity-row";
import { TUG_SESSION_ROW_STACK_DOT_SIZE } from "@/components/tugways/tug-session-row";
import { cardServicesStore } from "@/lib/card-services-store";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { useSessionBranch } from "@/lib/changeset-all-store";
import { useOverview } from "@/lib/overview-store";
import {
  groupBeatHistory,
  linesForScope,
  useDigest,
  type DigestLineEntry,
} from "@/lib/digest-store";
import {
  sessionCitation,
  useSessionIdentity,
  type SessionIdentity,
} from "@/lib/session-identity";
import {
  getSessionLedgerStore,
  useSessionLedger,
  useSessionLedgerRow,
} from "@/lib/session-ledger-store";

/**
 * The masthead's dot box. The row's denser cut, not the Cards card's 28: the masthead
 * is a 72px chrome tier and a dot that size would out-shout the name it marks.
 */
const MASTHEAD_DOT_SIZE = TUG_SESSION_ROW_STACK_DOT_SIZE;

export interface SessionMastheadProps {
  /** Which session the chrome is about. The only key the pane supplies. */
  sessionId: string;
  /**
   * The card wearing this chrome. Supplies the project dir for the panel's
   * workspace facts — a pane fact the pane already holds, not session state.
   */
  cardId?: string;
  /**
   * Where the telemetry widget mounts: a host element the pane renders inside
   * its control cluster, after the stack badge. The widget is the masthead's —
   * its trigger, its popover, its session facts — but its PLACE is the pane's,
   * and the pane is the only thing that knows what else stands in that row.
   *
   * Absent or null (the frame before the host mounts) → no widget. It is not
   * rendered in place instead: in place means absolutely positioned against the
   * cluster, which is exactly the arrangement that put it ahead of the badge.
   */
  accessoryHost?: HTMLElement | null;
  /**
   * Whether the pane wearing this masthead is FOLDED ([P01], [P03]).
   *
   * The one thing it changes is the activity line's register ([D185]): a
   * folded card is the masthead and nothing else, so the beat has two
   * lines and two facts to put on them. Everything else about the tier — its
   * extra height, the clamp that holds the beat at two lines — is CSS keyed
   * on the frame's own `data-folded` and needs nothing passed ([L06]);
   * this is here because which runs get RENDERED is not something a
   * stylesheet can decide.
   * @default false
   */
  folded?: boolean;
}

/** How many recent beats the activity line's popover lists. */
const BEAT_HISTORY_COUNT = 8;

/**
 * Raw-text form of a beat for the clipboard: `heading › text`. The history
 * popover's rows carry their group's heading — the Observer post they ran
 * under — which is the level that survives there; the masthead's own line
 * copies the beat alone.
 */
function composeLineCopy(heading: string | undefined, text: string): string {
  return heading !== undefined ? `${heading} › ${text}` : text;
}

/**
 * The activity line's popover body: the recent beats for this session, newest
 * first, GROUPED by Observer post ([B08]) so a written sentence heads the run
 * of beats that happened under it instead of repeating on each row. An empty
 * history reads as a quiet placeholder.
 */
function SessionBeatHistory({
  lines,
  headings,
}: {
  lines: readonly DigestLineEntry[];
  headings: readonly { atMs: number; text: string }[];
}): React.ReactElement {
  const groups = React.useMemo(
    () => groupBeatHistory(lines, headings),
    [lines, headings],
  );
  // A beat's file reference is a live reference here too, not a picture of
  // one: the popover is portalled out of the masthead's tree, so the
  // delegated layer that services the line has to be mounted again on the
  // frame. No insert target — a popover is not a composer, and the kinds a
  // beat line carries open themselves.
  const frameRef = React.useRef<HTMLDivElement | null>(null);
  useAnnotationClicks(frameRef, {});
  return (
    <TugPopupListFrame
      ref={frameRef}
      title="Recent beats"
      kind="item"
      className="session-beat-history"
      data-slot="session-beat-history"
    >
      {groups.length === 0 ? (
        <TugPopupListEmpty>No beats yet.</TugPopupListEmpty>
      ) : (
        <TugPopupListScroller data-slot="session-beat-history-body">
          {groups.map((group) => (
            <div className="session-beat-history-group" key={group.beats[0].key}>
              {group.heading !== undefined ? (
                <SessionBeatHistoryHeading heading={group.heading} />
              ) : null}
              {group.beats.map((beat) => (
                <SessionBeatHistoryRow
                  key={beat.key}
                  text={beat.text}
                  heading={group.heading}
                />
              ))}
            </div>
          ))}
        </TugPopupListScroller>
      )}
    </TugPopupListFrame>
  );
}

/** A group's heading — the Observer's post in calm muted prose (emphasis
 *  flattened in CSS), shown once above the beats that ran under it. */
function SessionBeatHistoryHeading({
  heading,
}: {
  heading: string;
}): React.ReactElement {
  const render = React.useMemo(() => renderBeatLine(heading), [heading]);
  return (
    <div className="session-beat-history-intent">
      {render.html.length === 0 ? (
        <>{heading}</>
      ) : (
        <span dangerouslySetInnerHTML={{ __html: render.html }} />
      )}
    </div>
  );
}

/** One beat row: a leading tone dot + the live action, the primary reading of
 *  the row. Right-click copies the raw `heading › beat`. */
function SessionBeatHistoryRow({
  text,
  heading,
}: {
  text: string;
  heading?: string;
}): React.ReactElement {
  // The same split every beat surface makes: a file-tool beat wears its
  // target as a file reference; anything else takes the markdown pipeline.
  const fileBeat = React.useMemo(() => parseBeatFileTarget(text), [text]);
  const render = React.useMemo(
    () => (fileBeat !== null ? null : renderBeatLine(text)),
    [fileBeat, text],
  );
  const copy = useCopyableButton(composeLineCopy(heading, text));
  const primary =
    fileBeat !== null ? (
      <BeatText text={text} />
    ) : render === null || render.html.length === 0 ? (
      <>{text}</>
    ) : (
      <span dangerouslySetInnerHTML={{ __html: render.html }} />
    );
  return (
    <TugPopupListItem
      ref={copy.ref as React.Ref<HTMLDivElement>}
      onContextMenu={copy.onContextMenu}
      className="session-beat-history-beat"
      indicator={<TugPopupListToneDot tone="default" />}
    >
      <TugPopupListItemText primary={primary} />
      {copy.contextMenu}
    </TugPopupListItem>
  );
}

/**
 * One telemetry row: a quiet label and its value.
 *
 * `enclosed` names a value that is a bordered thing of its own — the atom's
 * pill, the citation's badge — rather than a run of text. The distinction is
 * about CLIPPING: a text value is cut with an ellipsis by the cell around it,
 * and doing that to a pill cuts the pill's border off mid-curve. An enclosed
 * value is handed a cell that does not clip and shrinks it instead, and the
 * chip elides its own run inside its own border, which is what the gallery
 * draws.
 */
function TelemetryRow({
  label,
  enclosed = false,
  action,
  children,
}: {
  label: string;
  enclosed?: boolean;
  /** A trailing affordance for this row — the two copyable rows carry one. */
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      className="session-masthead-telemetry-row"
      data-enclosed={enclosed ? "true" : undefined}
    >
      <span className="session-masthead-telemetry-label">{label}</span>
      <span className="session-masthead-telemetry-value">{children}</span>
      {/* The cell is declared on EVERY row, empty or not, so the value column
          is one width down the whole panel — a track that appeared on two rows
          would step those two values in from the four above them. */}
      <span className="session-masthead-telemetry-action">{action}</span>
    </div>
  );
}

/**
 * The trailing COPY on a row whose value is copyable.
 *
 * `BlockCopyButton` is the suite's copy affordance and this is the shape a
 * popup already uses for it (see `PopupCopyButton`) — icon-only here, because
 * the row's key already says what is being copied and a `COPY` word beside a
 * one-line value would out-weigh it.
 *
 * `copyAction` rather than `getText` for both, because the atom's write is not
 * a text write: it puts the citation on `text/plain` AND the atom sidecar on
 * `dev.tugapp.prompt-atoms`, which is what makes a paste back into a Tug surface
 * re-materialize the live chip rather than a string ([D132]). It returns
 * `false` when the native bridge is absent (a browser-mode run), and the
 * plain-text write is the fallback — the same two-step `useCopyableText`
 * performs for the right-click path, so the button and the menu cannot copy
 * two different things.
 */
function TelemetryCopy({
  label,
  text,
  atom,
}: {
  label: string;
  text: string;
  atom?: SessionIdentity;
}): React.ReactElement {
  const copy = useCallback(async (): Promise<boolean> => {
    if (atom !== undefined && writeSessionAtomToClipboard(atom)) return true;
    if (text.length === 0) return false;
    await navigator.clipboard.writeText(text);
    return true;
  }, [atom, text]);
  return (
    <BlockCopyButton
      subtype="icon"
      emphasis="ghost"
      size="2xs"
      aria-label={label}
      data-slot="session-masthead-telemetry-copy"
      copyAction={copy}
    />
  );
}

/**
 * A stamp in the resting line's own format — `Aug 8, 7:02 AM` — or an em arc
 * when the ledger has none.
 *
 * Deliberately not `toLocaleString()`, which spelled a date the panel already
 * says elsewhere as `8/9/2026, 1:17:45 PM`: seconds nobody reads, a numeric
 * date beside a row of prose, and a width that pushed the value column past
 * the panel's own edge. One session, one way of saying when.
 */
function stamp(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return formatRestingStamp(ms);
}

/**
 * The STATE row: the ledger's own word for the session, and what it is doing
 * right now beside it.
 *
 * A LEAF for the same reason `TelemetryBirthRow` is one — `useSessionPhase`
 * reads the per-card `codeSessionStore`, whose snapshot changes on every
 * transcript event, and subscribing to it up in `SessionMasthead` would wake
 * the whole identity tier on each one ([P15]). A closed popover mounts no
 * content, so this subscription exists only while the panel is open.
 */
function TelemetryStateRow({
  sessionId,
  state,
}: {
  sessionId: string;
  state: string | null | undefined;
}): React.ReactElement {
  const phase = useSessionPhase(sessionId);
  // Lower-cased to sit beside the ledger's own lower-case state word: the pair
  // is one reading of one session, not a sentence and a label.
  const doing = SESSION_PHASE_LABELS[phase].toLowerCase();
  return (
    <TelemetryRow label="STATE">
      {state != null && state.length > 0 ? `${state} · ${doing}` : doing}
    </TelemetryRow>
  );
}

/**
 * The birth stamp, and what to call it.
 *
 * A `/compact`-born session is a "fake new" session — an implementation
 * detail of compaction rather than a genuinely new one — so its birth reads
 * "Compacted" rather than "Created". The date is the same fact either way;
 * only the verb changes.
 *
 * A LEAF, and that is the point: `compactionSeed` lives on the per-card
 * `codeSessionStore`, whose snapshot is the whole session state. Reading it
 * up in `SessionMasthead` would wake the masthead on every transcript event —
 * the exact churn [P15] keeps out of the identity path. Here the subscription
 * is a boolean selector inside the telemetry panel, and a closed popover
 * mounts no content, so it exists only while the panel is open.
 */
function TelemetryBirthRow({
  cardId,
  createdAtMs,
}: {
  cardId: string | undefined;
  createdAtMs: number | null | undefined;
}): React.ReactElement {
  const services = useSyncExternalStore(cardServicesStore.subscribe, () =>
    cardId === undefined ? null : cardServicesStore.getServices(cardId),
  );
  const store = services?.codeSessionStore ?? null;
  const compacted = useSyncExternalStore(
    store?.subscribe ?? NOOP_SUBSCRIBE,
    store !== null
      ? () => store.getSnapshot().compactionSeed !== null
      : () => false,
    () => false,
  );
  return (
    <TelemetryRow label={compacted ? "COMPACTED" : "CREATED"}>
      {stamp(createdAtMs)}
    </TelemetryRow>
  );
}

/** Stable no-op subscribe for a card whose services aren't constructed yet. */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

export function SessionMasthead({
  sessionId,
  cardId,
  accessoryHost = null,
  folded = false,
}: SessionMastheadProps): React.ReactElement {
  // The project dir behind this chrome. Read from the card binding — a pane
  // fact — rather than carried on the identity record, which deliberately
  // holds only the project's leaf name for display.
  const projectDir = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    useCallback(
      () =>
        cardId === undefined
          ? ""
          : cardSessionBindingStore.getBinding(cardId)?.projectDir ?? "",
      [cardId],
    ),
  );
  // The branch is telemetry: it rides the record for the panel and never
  // reaches a rendered name.
  const branch = useSessionBranch(projectDir.length > 0 ? projectDir : null);
  const identity = useSessionIdentity(sessionId, {
    projectDir: projectDir.length > 0 ? projectDir : undefined,
    branch,
  });
  const ledger = useSessionLedger(projectDir);
  // Re-validate this workspace's rows once for this card. The hook's first read
  // of an unseen path already issues `list_sessions`; what it cannot do is
  // notice that a path listed earlier in the session has drifted — terminal
  // sessions and other out-of-band JSONL writers emit no `session_updated`, and
  // the turn count, size, and last-used stamp they move are exactly what the
  // activity line reports at rest. Stale-while-revalidate, the same kick the
  // picker performs on open. An event, not a state mirror ([L02]).
  // Latched only on a kick that actually landed: the store singleton does not
  // exist until the connection is up, and the masthead mounts before that — a
  // ref set on the way past would swallow the one request this ever makes.
  const refreshedDirRef = useRef<string | null>(null);
  useEffect(() => {
    if (refreshedDirRef.current === projectDir || projectDir.length === 0) return;
    const store = getSessionLedgerStore();
    if (store === null) return;
    refreshedDirRef.current = projectDir;
    store.refresh(projectDir);
  }, [projectDir, ledger.status]);
  const digest = useDigest();
  const overview = useOverview();
  const [historyOpen, setHistoryOpen] = React.useState(false);
  /*
    The beat line's own DOM node, so the beat-history popover can anchor to
    the run the reader is looking at. An ANCHOR rather than a trigger: the
    stage already carries a right-click copy and its own click toggle, and
    composing Radix's trigger onto an element with click choreography of its
    own is exactly the pointerdown/pointerup fight `TugPopoverAnchor` exists
    to avoid.
  */
  const stageElRef = useRef<HTMLElement | null>(null);

  /*
    The masthead's own delegated annotation layer. The beat line's file
    reference is stamped exactly as a path in transcript prose is, and until
    this listener existed the chrome was the one place that stamp bought
    nothing: an underline and a hover that named a file, and no way to open it.
    One listener on the whole masthead, so every reference the chrome ever
    carries is serviced by the same route.
  */
  const rootRef = useRef<HTMLDivElement | null>(null);
  useAnnotationClicks(rootRef, {});

  // The ledger's row for this session, for the telemetry panel: by id, not out
  // of the workspace listing, because a just-spawned session is content-empty
  // and the listing deliberately omits it. The row's own three lines read the
  // same facts through the same hook inside `SessionIdentityRow`.
  const row = useSessionLedgerRow(sessionId, projectDir);
  // Not `row.created_at` alone: the shared resolver falls through to the card's
  // own replay anchor, which is the only source for a freshly-bound card in a
  // project nothing has listed yet. The row above is what it reads — handed
  // over rather than looked up a second time.
  const createdAtMs = useSessionCreatedAtMs(cardId, row);
  // The last few beats for this session — shown in the activity line's popover.
  const history = linesForScope(digest.lines, sessionId, BEAT_HISTORY_COUNT);
  // …and the Observer posts they group under ([B08]). Newest-first, to match
  // the lines, and filtered to this session's own — the channel also carries
  // the user's questions and the Operator's answers, and neither is a heading
  // for anything the session did.
  const postHeadings = React.useMemo(
    () =>
      overview.posts
        .filter(
          (post) => post.author === "observer" && post.sessionId === sessionId,
        )
        .map((post) => ({ atMs: post.atMs, text: post.body }))
        .reverse(),
    [overview.posts, sessionId],
  );
  // Right-click the SUMMARY panel's citation → Copy that flat string alone.
  // The row's own menu offers the atom's whole flavor set; this one writes
  // exactly the text the row it sits on is showing, which is that row's point.
  const copyCitation = useCopyableButton(
    sessionCitation(identity, { project: true }),
  );

  return (
    <div
      className="session-masthead tug-masthead-frame"
      data-slot="session-masthead"
      ref={rootRef}
    >
      <SessionIdentityRow
        className="session-masthead-row tug-masthead-frame-row"
        sessionId={sessionId}
        cardId={cardId}
        projectDir={projectDir}
        // The branch rides the identity for the telemetry panel and never
        // reaches a rendered name; passing the masthead's own context is what
        // keeps the row's record and this component's the same record.
        identityContext={{
          projectDir: projectDir.length > 0 ? projectDir : undefined,
          branch,
        }}
        // The dense cut. A 72px chrome tier with a 28px dot in it would have
        // the mark out-shouting the name it marks.
        dotSize={MASTHEAD_DOT_SIZE}
        // And the tier packs against the COLUMN the dot stands in rather than
        // against the dot's own ink. A masthead is worn by more than one kind
        // of card — a document's glyph fills its box where this dot paints a
        // small disc inside a ring — and the slot badge stands under both. Ink
        // packing puts each of those on its own vertical; the column is the one
        // fact all three can share.
        indicatorPacking="column"
        // The bound arc is not the masthead's to render: it rides the title's
        // own grammar, alongside the project the callsign already names, which
        // `SessionIdentityRow` composes. What sat here was a badge in the title
        // line's trailing slot, competing with pane chrome for space and often
        // repeating the session's own name.
        //
        // The two lines below the title start where the TITLE does — three
        // lines on two verticals read as a stack that was assembled rather than
        // set. A card-wide chrome tier can afford the indent a rail cannot.
        subAlign="title"
        tape
        // The line is being READ here, not scanned, so the beat is paced and
        // set through the markdown pipeline: a tool call's backticked paths and
        // commands are exactly what that pipeline is for.
        pace
        markdown
        activityClassName="session-masthead-beat-text"
        // The folded card's beat has two lines and two jobs ([D185]):
        // the intent above, the action below, and a finished line at rest.
        // The open card's masthead reads in the one-line register, where the
        // transcript underneath is already saying what the session is for.
        activityRegister={folded ? "wall" : "line"}
        /*
          Right-click ANYWHERE on the three lines offers the session's copies —
          the atom, the citation, the id, the description, the newest beat.
          Claimed by the row rather than by the runs inside it, because the
          title's copy surface is exactly as wide as its glyphs and everything
          around it used to answer with something else or with nothing: the
          description line and the masthead's own ground fell through to the
          app's "No Actions" ([D132]).

          With the menu here the identity's hover card is off. It was naming
          the session and its description two lines under a row already showing
          both, and the facts it added — the citation, the lineage — are things
          to act on, which a tooltip cannot offer.
        */
        identityMenu
        /*
          This row IS this card's chrome, so the menu offers no way to "go to"
          the session — the card to raise is the one the pointer is in. The
          title bar renders above the card host, so the context that answers
          this everywhere else cannot see it from here.
        */
        hostCardId={cardId}
        nameProps={{ className: "session-masthead-title" }}
        /*
          The tape is the entry point to the expanded Activity card: clicking it
          opens a popover of per-channel small-multiples for this session. The
          instrument is the row's; only this wrapper is the masthead's.
        */
        renderTape={(tape) => (
          <TugPopover>
            <TugPopoverTrigger>
              <button
                type="button"
                className="session-masthead-spark-trigger"
                tabIndex={-1}
                data-tug-focus="refuse"
                data-no-activate=""
                aria-label="Session beat detail"
              >
                {tape}
              </button>
            </TugPopoverTrigger>
            <TugPopoverContent side="bottom" align="end" sideOffset={8} arrow>
              <SessionActivityCard session={sessionId} />
            </TugPopoverContent>
          </TugPopover>
        )}
        stageProps={{
          ref: stageElRef as React.Ref<HTMLSpanElement>,
          // The line toggles its history — unless the press landed on the
          // beat's file reference, which is drilling THROUGH the line to what
          // it names. One press, one act.
          onClick: (event) => {
            if (annotationClaimsClick(event.nativeEvent)) return;
            setHistoryOpen((open) => !open);
          },
          className: "session-masthead-stage",
        }}
      />
      {copyCitation.contextMenu}

      {/*
        The beat-history history, anchored on the line it is the history OF.
        This used to hang off the retired `PULSE` pill, and the pill is now a
        placeholder rather than a permanent label — so the affordance moves to
        the reading itself: click what you are reading to see more of it.

        dismissOnChainActivity=false: a row's right-click → Copy dispatches the
        `copy` action through the responder chain, which would otherwise read as
        foreign chain activity and close this popover mid-copy. The copy
        originates from WITHIN the popover, so it must not dismiss it; Escape,
        click-outside, and a second click on the line still close it.
      */}
      <TugPopover
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        dismissOnChainActivity={false}
      >
        <TugPopoverAnchor virtualRef={stageElRef} />
        <TugPopoverContent side="bottom" align="start" sideOffset={8} arrow>
          <SessionBeatHistory lines={history} headings={postHeadings} />
        </TugPopoverContent>
      </TugPopover>

      {/*
        The telemetry widget: everything identity deliberately does not say.

        PORTALED into the pane's control cluster, where it stands as an ordinary
        member of that row rather than as a box positioned against it. What it
        SAYS is the masthead's — the session's state, turns, branch, citation —
        and what it stands beside is the pane's, so the pane hands over a host
        and the content comes from here. Before that it was absolute, pinned to
        the cluster's measured width, which meant it always sat one place ahead
        of the stack badge and the masthead's title line had to reserve a 28px
        box by hand.

        The React tree is unchanged by the portal — this subtree still reads the
        masthead's stores and still bubbles into it ([D132]).

        A POPOVER, not a placard. `TugPlacard` renders in place and asks its
        caller to own the vertical axis inside a positioned ancestor — a
        contract a 72px chrome tier with `overflow: hidden` cannot honour, so
        the panel opened clipped by the bar it was mounted in and painted over
        the lines beside it. The popover portals to the deck's canvas overlay
        and positions itself against this button, which is what every other
        chrome affordance in the masthead already does.

        The trigger is a ghost icon `TugButton`, the same control the stack
        badge, the `…` menu, the width chevron, and the close box are. Standing
        in that row is not enough to look like a member of it: the cluster's
        palette is addressed at `.tug-pane-title-bar-controls .tug-button`, so
        a hand-rolled button matched none of it and took a flat global muted
        text token in every state — full-strength neighbours beside a grey
        glyph whose only hover was a 12% wash of its own colour. That reads as
        a disabled control, and it was never disabled.

        The tooltip anchors a SPAN rather than the button: `TugTooltip` and
        `TugPopoverTrigger` both hand their child to a Radix `asChild` slot and
        neither forwards what the other injects, so they cannot nest directly —
        the same composition every control beside this one uses.
      */}
      {accessoryHost !== null && createPortal(
      <>
      {/* The SUMMARY leads and Reveal follows, which is the cluster's rule and
          not this card's preference: the rollup reads right to left as a fixed
          spine — bullseye, card width, Reveal in Finder — and only the
          leftmost positions belong to whatever a particular card adds. Reveal
          is the same act on a Text card, so it lands at the same offset on
          both; the summary is this card's own and is what moves. See
          `SHARED_VERB_RANK` in `chrome/tug-pane.tsx`, which enforces the same
          order for the verbs a card publishes through the items store. */}
      <TugTooltip content="Show this session's summary">
      <span className="tug-pane-title-bar-tooltip-anchor">
      <TugPopover dismissOnChainActivity={false}>
        <TugPopoverTrigger>
          <TugButton
            subtype="icon"
            emphasis="ghost"
            role="action"
            size="sm"
            icon={<Summary />}
            data-slot="session-masthead-widget"
            // Chrome, like the close button — never a card-cycle focus stop.
            // `TugButton` already refuses first responder on click; opening the
            // panel on a background card must not raise it, hence no-activate.
            tabIndex={-1}
            data-no-activate=""
            aria-label="Session telemetry"
          />
        </TugPopoverTrigger>
        <TugPopoverContent side="bottom" align="end" sideOffset={8} arrow>
          <TugPopupListFrame
            title="Session Summary"
            kind="item"
            className="session-masthead-telemetry"
            data-slot="session-masthead-telemetry"
          >
            <div className="session-masthead-telemetry-body">
              <TelemetryStateRow
                sessionId={sessionId}
                state={row?.state ?? identity.state}
              />
              <TelemetryRow label="TURNS">
                {row === null
                  ? "—"
                  : row.file_size != null && row.file_size > 0
                    ? `${row.turn_count} · ${formatByteSize(row.file_size)}`
                    : row.turn_count}
              </TelemetryRow>
              {/* The card's Z0 load-control bar used to carry this same line;
                  the telemetry panel is where session telemetry lives now, so
                  it says it once.

                  There is no LAST USED row beside it, and that is the gallery's
                  row set rather than an omission: the activity line under the
                  title says `Last updated: …` at rest, on this very card, a few
                  pixels above this panel. */}
              <TelemetryBirthRow cardId={cardId} createdAtMs={createdAtMs} />
              <TelemetryRow label="BRANCH">{identity.branch ?? "—"}</TelemetryRow>
              {/* The two copyable forms sit TOGETHER, the atom directly above
                  the flat citation, each labeled by what a paste of it yields:
                  the atom returns the chip, the citation is flat text for
                  anywhere outside Tug. Both are enclosed values — bordered
                  things that elide inside their own border rather than being
                  cut off by the cell. */}
              <TelemetryRow
                label="ATOM"
                enclosed
                action={
                  <TelemetryCopy
                    label="Copy session atom"
                    text={sessionCitation(identity, { project: true })}
                    atom={identity}
                  />
                }
              >
                <TugSessionIdentity
                  identity={identity}
                  tier="chip"
                  // This panel is the card's own chrome, so the chip's menu
                  // offers no way to "go to" a session the pointer is already
                  // in — see the row's `hostCardId` above.
                  hostCardId={cardId}
                  className="session-masthead-telemetry-atom"
                />
              </TelemetryRow>
              <TelemetryRow
                label="CITATION"
                action={
                  <TelemetryCopy
                    label="Copy session citation"
                    text={sessionCitation(identity, { project: true })}
                  />
                }
              >
                {/* The citation is the sanctioned flat-text form, and the only
                    place monospace appears in session identity. FLAT text, and
                    nothing else: it wore a `TugCopyBadge` here, which put a
                    bordered, tinted, icon-bearing chip on the row directly under
                    the atom — two enclosures in a row, the quieter fact wearing
                    the louder box. The row above is the chip; this row is the
                    string you would paste. Copy stays on right-click, the same
                    gesture the title and the beat line already answer, which
                    costs the row no ink at all. */}
                <span
                  ref={copyCitation.ref as React.Ref<HTMLSpanElement>}
                  onContextMenu={copyCitation.onContextMenu}
                  className="session-masthead-telemetry-citation"
                >
                  {sessionCitation(identity, { project: true })}
                </span>
              </TelemetryRow>
            </div>
          </TugPopupListFrame>
        </TugPopoverContent>
      </TugPopover>
      </span>
      </TugTooltip>
      {/*
        Open the session's project directory in the Finder. The gesture used to
        live on the Z4B project chip; the title-bar rework took that row away,
        and this is where it returns — beside the summary, in the same control
        cluster, wearing the same ghost icon button. Rendered only when the card
        is bound to a project, since there is nothing to open otherwise.

        LAST in the card's own run, so it sits directly beside the pane's width
        control on this card exactly as it does on a Text card.
      */}
      {projectDir.length > 0 && (
        <TugTooltip content={`Reveal in Finder: ${projectDir}`}>
          <TugButton
            subtype="icon"
            emphasis="ghost"
            role="action"
            size="sm"
            icon={<FolderOpenDot />}
            data-slot="session-masthead-reveal"
            tabIndex={-1}
            data-no-activate=""
            aria-label="Reveal project folder in Finder"
            onClick={() => openPathInOS(projectDir, "folder")}
          />
        </TugTooltip>
      )}
      </>,
      accessoryHost,
      )}
    </div>
  );
}
