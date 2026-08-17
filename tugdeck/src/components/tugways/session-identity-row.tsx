/**
 * SessionIdentityRow — one session, resolved and rendered. The single component
 * every surface that shows a session mounts.
 *
 *   [dot] <name> : <callsign>        ← what it IS, and whether it is working
 *   <description>                    ← what it is FOR
 *   <activity>                  ~~~  ← what it is doing, with its tape
 *
 * {@link TugSessionRow} is the SHAPE — presentational, every part a node it is
 * handed. This is the shape with the stores behind it: the identity, the
 * description ladder, the activity ladder, the phase dot, and the tape, all
 * resolved once here rather than at each mount site.
 *
 * That distinction is the whole point of the file. The shape was already shared
 * — the masthead, the picker, and the Lens all mounted `TugSessionRow` — and
 * the surfaces still drifted, because everything that DECIDES what goes into
 * the shape was written three times. Three description ladders (two of which
 * had three rungs and one two), three activity ladders (one with a compaction
 * pin, one without, one with a dwell queue), three spellings of the
 * `pulse/enabled` gate, and two copies of the sparkline. A shape can only make
 * three surfaces agree about how a row PACKS; it cannot make them agree about
 * what a row SAYS. This can.
 *
 * ── The three knobs ──────────────────────────────────────────────────────
 * The surfaces genuinely differ in three ways, and only three, so those are
 * declared props and everything else is one answer:
 *
 *  1. **{@link SessionIdentityRowProps.dotSize}** — the indicator's glyph box.
 *     The dense mounts (chrome, the picker's rows) take
 *     {@link TUG_SESSION_ROW_STACK_DOT_SIZE}; the Lens's monitor rail takes
 *     {@link TUG_SESSION_ROW_INDICATOR_SIZE}. ONE number, used for both the dot
 *     and the ink-slack correction the title is measured by — those were two
 *     props at every mount site, and two numbers that must agree is one number
 *     with a way to be wrong.
 *  2. **`subAlign`** — whether the two sub-lines hang off the title or off the
 *     row's own edge. `TugSessionRow`'s knob, forwarded; see
 *     {@link TugSessionRowSubAlign}.
 *  3. **{@link SessionIdentityRowProps.tape}** — whether the activity
 *     sparkline draws. The picker's rows are a list to pick FROM rather than a
 *     monitor, so they carry none, and a row reserving width for a graph it does
 *     not draw is width taken from the text for nothing. Where it IS asked for
 *     it draws unconditionally: a session with no work behind it gets a
 *     flatline, because an instrument that disappears when it reads zero cannot
 *     be told apart from one that is broken.
 *
 * Everything past those three is either the same on every surface (both
 * ladders, the beat grammar, the `pulse/enabled` gate) or is a piece of the
 * mount's own furniture handed straight through (the Lens's slot picker, the
 * picker's badges and trash, the masthead's popovers and copy handles).
 *
 * ── The description ladder ([D132]) ──────────────────────────────────────
 * The agent's rolling synopsis, else the session's own first prompt, else the
 * date it was created. The lower two are facts STANDING IN for a line nobody
 * has written yet, so they are marked and painted a step quieter.
 *
 * All three rungs on every surface. The Lens carried only two, on the argument
 * that its rows are always bound live cards and so never reach the prompt rung
 * — which, if true, makes the rung free, and if false makes it the one
 * human-meaningful line the row could have shown.
 *
 * ── The activity ladder ──────────────────────────────────────────────────
 * A caller's override, else the compaction pin, else the live beat, else the
 * rest sentence. The overrides exist for facts a row knows that the pulse feed
 * cannot report — a session held by a terminal, a row whose one fact is that it
 * failed to resume.
 *
 * The feed is read only when {@link SessionIdentityRowProps.beats} says this row
 * is live, and that gate is load-bearing rather than an optimization:
 * `latestLineForScope` answers with app-wide ambience for any scope, so a closed
 * session's row would otherwise narrate whatever the app happened to be saying.
 *
 * Laws: [L02] every store enters through `useSyncExternalStore` (inside the
 *       hooks); [L06] appearance is CSS on data attributes, never React state;
 *       [L20] `TugSessionRow` is composed through its published props only.
 * Decisions: [D123] one name, produced in one place; [D132] one row, three
 *       surfaces.
 *
 * @module components/tugways/session-identity-row
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { renderFilterHighlight } from "@/components/tugways/filter-highlight";
import { PulseBeatText } from "@/components/tugways/pulse-beat-text";
import { SessionActivitySparkline } from "@/components/tugways/session-activity-sparkline";
import { SessionPhaseDot } from "@/components/tugways/session-phase-dot";
import { useSessionIdentityMenu } from "@/components/tugways/session-identity-menu";
import {
  TugSessionRow,
  TUG_SESSION_ROW_STACK_DOT_SIZE,
  type TugSessionRowProps,
} from "@/components/tugways/tug-session-row";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import { truncateForDisplay } from "@/components/tugways/cards/session-picker-format";
import {
  COMPACTING_PULSE_TEXT,
  useIsCompactingCard,
} from "@/lib/compaction-progress-store";
import { parseBeatFileTarget } from "@/lib/pulse-line/beat-file-target";
import { formatRestingStamp } from "@/lib/pulse-line/resting-line";
import { renderPulseLine } from "@/lib/pulse-line/render-pulse-line";
import { latestLineForScope, usePulse } from "@/lib/pulse-store";
import {
  sessionActivityBeat,
  sessionActivityRestLine,
} from "@/lib/session-activity-line";
import { useSessionCreatedAtMs } from "@/lib/session-created-at";
import {
  useSessionIdentity,
  type SessionIdentityContext,
} from "@/lib/session-identity";
import { useSessionLedgerRow } from "@/lib/session-ledger-store";
import type { SessionRow } from "@/protocol";

/**
 * Every line holds the row at least this long before the next replaces it.
 *
 * The pacing is what makes the voice readable rather than a strobe: the
 * machine's commentary arrives in bursts, and a line that flickered past in
 * 200ms would be a texture rather than a sentence. Opt-in
 * ({@link SessionIdentityRowProps.pace}) — a list of rows the reader is
 * scanning rather than reading wants the newest fact, and the picker's cells
 * may hold no state at all.
 */
export const MIN_DWELL_MS = 1_800;

/**
 * The handle on a row whose parts came from the stores, as distinct from a bare
 * {@link TugSessionRow} handed its parts by a mount site. The gallery's specimen
 * is the second kind and must stay findable as such.
 */
const IDENTITY_ROW_CLASS = "session-identity-row";

/** What the activity line is showing: a live beat, or a composed sentence. */
interface DisplayEntry {
  key: string;
  text: string;
  /**
   * Not a beat. The rest sentence, the compaction pin, and a caller's override
   * are all facts the row composed rather than news the session sent, so none
   * goes through the markdown pipeline and none is what a line copy carries.
   */
  placeholder: boolean;
  /**
   * Swap this entry in the moment it arrives, skipping the dwell — the user's
   * own clear and the compaction pin both answer a gesture.
   */
  immediate?: boolean;
}

/**
 * A composed line's entry.
 *
 * Keyed BY ITS TEXT, and `immediate`, so the numbers land the moment they move —
 * a constant key would hold the previous sentence on screen after a turn end
 * refreshed the very facts it reports.
 */
function composedEntry(text: string): DisplayEntry {
  return {
    key: `__activity_composed__:${text}`,
    text,
    placeholder: true,
    immediate: true,
  };
}

/**
 * The compaction pin. A `/compact` turn streams nothing for minutes, and the
 * submit that opened it cleared the line — so without this the whole run reads
 * as an idle `Ready.`, which is exactly when the user has pulled the progress
 * sheet down and has only this line to go on. Held for the run's lifetime.
 */
const COMPACTING_ENTRY: DisplayEntry = Object.freeze({
  key: "__pulse_compacting__",
  text: COMPACTING_PULSE_TEXT,
  placeholder: false,
  immediate: true,
});

// ---------------------------------------------------------------------------
// The activity run
// ---------------------------------------------------------------------------

interface ActivityTextProps {
  entry: DisplayEntry;
  highlight: string;
  className?: string;
}

/**
 * The activity run, in its ordinary form.
 *
 * Three renderings, and which one applies is the entry's own business rather
 * than the mount's: a composed sentence takes the surface's filter mark (it is
 * the searchable fact on the line); a file-tool beat wears its target as a file
 * reference — glyph plus basename, full path on hover — never a spelled-out
 * path; anything else is a beat set as plain text.
 *
 * No state, no refs, no effects, so a `TugListView` cell bound by the
 * pure-renderer rule can mount it.
 */
function ActivityText({
  entry,
  highlight,
  className,
}: ActivityTextProps): React.ReactElement {
  const fileBeat = React.useMemo(
    () => (entry.placeholder ? null : parseBeatFileTarget(entry.text)),
    [entry],
  );
  if (entry.placeholder) {
    return (
      <span className={className}>
        {renderFilterHighlight(entry.text, highlight)}
      </span>
    );
  }
  if (fileBeat !== null) {
    return <PulseBeatText text={entry.text} className={className} />;
  }
  return <span className={className}>{entry.text}</span>;
}

/**
 * The activity run, through the markdown pipeline.
 *
 * A beat is a tool call, so backticked paths and commands are exactly what the
 * pipeline is for. The pulse-line library owns fidelity and safety (math-first
 * split, sanitized markdown, KaTeX, total-function fallback); this only
 * re-renders once a lazy KaTeX load resolves, then every render is synchronous.
 * `html: ""` is the library's render-as-plain-text signal.
 *
 * A separate component from {@link ActivityText}, and mounted only when
 * {@link SessionIdentityRowProps.markdown} asks for it, because the lazy engine
 * needs a reducer and an effect — which a picker cell may not hold.
 */
function ActivityMarkdownText({
  entry,
  highlight,
  className,
}: ActivityTextProps): React.ReactElement {
  const [engineEpoch, bumpEngineReady] = React.useReducer(
    (n: number) => n + 1,
    0,
  );
  const fileBeat = React.useMemo(
    () => (entry.placeholder ? null : parseBeatFileTarget(entry.text)),
    [entry],
  );
  // engineEpoch keys the memo so the resolved KaTeX engine re-renders the SAME
  // entry with real typesetting (the first pass showed the escaped source
  // while the engine loaded).
  const render = React.useMemo(
    () =>
      entry.placeholder || fileBeat !== null ? null : renderPulseLine(entry.text),
    [entry, fileBeat, engineEpoch],
  );
  React.useEffect(() => {
    const pending = render?.pending;
    if (pending == null) return;
    let live = true;
    void pending.then(() => {
      if (live) bumpEngineReady();
    });
    return () => {
      live = false;
    };
  }, [render]);
  if (entry.placeholder) {
    return (
      <span className={className}>
        {renderFilterHighlight(entry.text, highlight)}
      </span>
    );
  }
  if (fileBeat !== null) {
    return <PulseBeatText text={entry.text} className={className} />;
  }
  if (render === null || render.html.length === 0) {
    return <span className={className}>{entry.text}</span>;
  }
  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: render.html }}
    />
  );
}

/**
 * The dwell queue: `target` is what the store wants shown; the return is what
 * the row shows. A swap happens immediately when the current line has dwelt
 * long enough (or the target is marked `immediate`); otherwise the newest
 * target waits out the remainder. A swap replaces the text INSTANTLY — one
 * node, no animation, because two different strings cross-fading in one box
 * interleave their glyphs into a smash.
 *
 * `enabled: false` is a pass-through: the target is returned verbatim, the
 * effect returns before it reads anything, and no timer is ever scheduled. A
 * knob rather than a second component for two reasons. Hooks cannot be called
 * conditionally — and, the load-bearing one, the swap has to re-render the ROW
 * rather than a leaf inside it. `TugPulse` measures its own middle truncation in
 * an effect that runs when `TugPulse` renders; a dwell living below it swaps the
 * text where that effect cannot see it, and the run silently stops truncating
 * (at0375's tape-gap assertion is what says so).
 *
 * **Disabled is inert, not absent.** The `useState` and the three refs are still
 * declared when `enabled` is false — a `TugListView` cell bound by the
 * pure-renderer rule ([D17]) mounts this and gets state it never uses. That
 * holds only because the disabled return ignores `current` entirely; a future
 * edit that read `current` outside the `enabled` guard would hand a recycled
 * cell the previous row's line. Read the guard as the contract, not the
 * ceremony.
 *
 * Local presentation data: refs and timers, changing WHAT text exists rather
 * than how it looks, so no appearance passes through React state ([L06]/[L22]).
 */
function useDwellDisplay(target: DisplayEntry, enabled: boolean): DisplayEntry {
  const [current, setCurrent] = useState<DisplayEntry>(target);
  const currentKeyRef = useRef(target.key);
  const lastSwapAtRef = useRef(0);
  const pendingRef = useRef<DisplayEntry | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    currentKeyRef.current = current.key;
  }, [current.key]);

  const swap = useCallback((next: DisplayEntry): void => {
    setCurrent((prev) => (prev.key === next.key ? prev : next));
    lastSwapAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (target.key === currentKeyRef.current) {
      pendingRef.current = null;
      return;
    }
    // The user's own clear (submit → placeholder) and the compaction pin feel
    // immediate; dwell only paces the machine's stream.
    if (target.immediate === true) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = null;
      swap(target);
      return;
    }
    const remaining = lastSwapAtRef.current + MIN_DWELL_MS - Date.now();
    if (remaining <= 0 && timerRef.current === null) {
      swap(target);
      return;
    }
    // Within the dwell: the newest target wins when the window opens.
    pendingRef.current = target;
    if (timerRef.current === null) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (pending !== null) swap(pending);
      }, Math.max(remaining, 0));
    }
  }, [target, swap, enabled]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return enabled ? current : target;
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

export interface SessionIdentityRowProps
  extends Omit<
    TugSessionRowProps,
    | "name"
    | "indicator"
    | "indicatorSize"
    | "description"
    | "descriptionStandIn"
    | "activity"
    | "sparkline"
  > {
  /** Whose session. The only key most surfaces hold, and the only one needed. */
  sessionId: string;
  /**
   * The card showing this session, when there is one. Supplies the compaction
   * pin's scope and the replay-derived creation anchor; a row for a session no
   * card holds simply passes none.
   */
  cardId?: string;
  /** The workspace the session belongs to — the ledger read's key. */
  projectDir?: string;

  // ── Knob 1: the indicator's size ───────────────────────────────────────
  /**
   * The phase dot's glyph box, in px — a RING box, not a line height: the dot
   * paints at a fraction of it and the ring travels to its edge.
   *
   * ONE number, and the row is built from it twice: the dot is drawn at this
   * size, and the title's leading is corrected by the room this size of ink
   * leaves inside the line's fixed advance. Those were two props every mount
   * site passed side by side, which is one number with a way to be wrong.
   * @default TUG_SESSION_ROW_STACK_DOT_SIZE
   */
  dotSize?: number;
  /**
   * Whether the dot's period is jittered — on in a LIST of separate sessions,
   * each doing its own work, and off where the dots belong to one thing.
   * @default false
   */
  drift?: boolean;

  // ── Knob 3: the tape (knob 2, `subAlign`, is TugSessionRow's) ──────────
  /**
   * Whether the activity sparkline draws — and where it is asked for, it draws
   * ALWAYS. A session with no work behind it shows a flatline; that is the
   * instrument reading zero, not a reason to take the instrument away.
   * @default false
   */
  tape?: boolean;
  /**
   * Wrap the tape before it is mounted — for a surface that hangs an
   * affordance on it. The masthead's tape is the trigger for the expanded
   * Activity card; the Lens's is a reading and nothing more.
   */
  renderTape?: (tape: React.ReactNode) => React.ReactNode;

  // ── What the caller already knows ──────────────────────────────────────
  /** Further identity facts the caller holds — a ledger row's state, lineage. */
  identityContext?: SessionIdentityContext;
  /**
   * The ledger row the caller is ALREADY holding — the picker browses a whole
   * workspace and has every row in hand. Given, it is the source for the
   * description's prompt rung and the activity's rest facts; omitted, they are
   * read from the ledger by id.
   */
  row?: SessionRow | null;
  /** A list surface's filter query, painted over the runs that can carry it. */
  highlight?: string;
  /**
   * Cap the description at this many characters. The line elides in CSS
   * whatever this says, so it is a bound on the TEXT rather than the layout —
   * a dense list of rows keeps a runaway prompt from riding in the DOM.
   * Whitespace is flattened either way.
   */
  descriptionMaxChars?: number;
  /**
   * What the activity line says INSTEAD of anything the feed could report — a
   * session held by a terminal, a row whose one fact is that it failed to
   * resume. Takes the filter mark, like every other composed line.
   */
  activityOverride?: string | null;
  /**
   * Whether this row reads the live pulse feed.
   *
   * Load-bearing rather than an optimization: `latestLineForScope` answers with
   * app-wide ambience for any scope, so a row for a session this app is not
   * running would otherwise narrate whatever the app happened to be saying.
   * @default true
   */
  beats?: boolean;
  /**
   * Pace the beat — hold each line {@link MIN_DWELL_MS} before the next
   * replaces it. For a line being READ; a list being scanned wants the newest
   * fact. Off, the dwell is a pass-through that schedules and writes nothing,
   * which is what lets a cell bound by the pure-renderer rule mount this.
   * @default false
   */
  pace?: boolean;
  /**
   * Run the beat through the markdown pipeline — backticks, math, the lot.
   * Costs a lazily-loaded engine and an effect.
   * @default false
   */
  markdown?: boolean;
  /** Class on the activity run itself, for a surface styling its ink. */
  activityClassName?: string;
  /**
   * Props for the element wrapping the TITLE. The identity runs are rendered
   * inside whatever this describes.
   */
  nameProps?: React.ComponentProps<"span">;
  /**
   * Whether the WHOLE row answers a right-click with the session's copies —
   * the atom, the citation, the id, the description, the newest beat. See
   * {@link useSessionIdentityMenu}.
   *
   * On, the identity's hover card is off, and that pairing is the point rather
   * than a side effect: the tooltip and the menu were showing the same facts
   * over the same pixels, and only one of them can be acted on.
   *
   * Off for the picker's cells, which are pure render functions and are a list
   * to pick FROM — a right-click there is a gesture aimed at the picking, not
   * at the session.
   * @default false
   */
  identityMenu?: boolean;
  /**
   * The card this row is MOUNTED IN, for the menu's go-to item. Only a surface
   * that is a card's own chrome needs to say — the masthead renders in the
   * pane title bar, above the card host whose context every other mount reads.
   * See {@link SessionIdentityMenuOptions.hostCardId}.
   */
  hostCardId?: string;
}

export function SessionIdentityRow({
  sessionId,
  cardId,
  projectDir = "",
  dotSize = TUG_SESSION_ROW_STACK_DOT_SIZE,
  drift = false,
  tape = false,
  renderTape,
  identityContext,
  row: rowOverride,
  highlight = "",
  descriptionMaxChars,
  activityOverride = null,
  beats = true,
  pace = false,
  markdown = false,
  activityClassName,
  nameProps,
  identityMenu = false,
  hostCardId,
  className,
  ...rest
}: SessionIdentityRowProps): React.ReactElement {
  // Identity, through the one resolver — so a `/rename` or a callsign reroll
  // repaints every surface with no reload ([D123]). A mount that also needs the
  // record for its own furniture calls the same hook with the same context and
  // gets the same record; there is no second copy to keep in step.
  const identity = useSessionIdentity(
    sessionId,
    identityContext ?? {
      projectDir: projectDir.length > 0 ? projectDir : undefined,
    },
  );

  // The session's own ledger row: the turn count, the on-disk size, when it
  // last moved, and the first prompt — the description's middle rung and the
  // activity's rest form. The caller's row wins when it has one, and it wins
  // INSIDE the hook rather than after it: a picker that already holds every row
  // in the workspace should not also be listening to the ledger for each of
  // them, and `??` on the way out would have left it doing exactly that.
  const facts = useSessionLedgerRow(sessionId, projectDir, rowOverride);

  // When the session was made. Two sources, resolved once and shared, so a
  // masthead and a Lens row cannot date the same session differently. The row
  // is handed over rather than read again — `facts` is already whichever row
  // this mount trusts, and the resolver's own second read of the same row was
  // a duplicate subscription on every session row in the app.
  const cardCreatedAtMs = useSessionCreatedAtMs(cardId, facts);
  const createdAtMs =
    cardCreatedAtMs !== null && cardCreatedAtMs > 0 ? cardCreatedAtMs : null;

  const pulse = usePulse();
  // Scoped to THIS card, not the whole runs map: a map snapshot changes
  // identity on every write to any card, so one `/compact` re-rendered every
  // session row in the app. A row with no card subscribes to nothing at all.
  const compacting = useIsCompactingCard(cardId);

  // ── The description ladder ([D132]) ───────────────────────────────────
  const prompt = facts?.last_user_prompt?.trim() ?? "";
  const descriptionSource =
    identity.description ??
    (prompt.length > 0
      ? prompt
      : createdAtMs !== null
        ? `Created ${formatRestingStamp(createdAtMs)}`
        : "");
  // Flattened always, capped only where the caller asks. A prompt is the one
  // rung that can carry newlines, and a multi-line run inside a `nowrap` box
  // is a line whose break the reader cannot see.
  const description = React.useMemo(
    () =>
      truncateForDisplay(
        descriptionSource,
        descriptionMaxChars ?? Number.MAX_SAFE_INTEGER,
      ),
    [descriptionSource, descriptionMaxChars],
  );
  // The same text under no budget at all — what the hover shows when the line
  // cannot fit the description. Flattened by the same call, so the tooltip and
  // the line differ in LENGTH only and the reader is reading the continuation
  // of the run they hovered rather than a differently-shaped one.
  const descriptionFull = React.useMemo(
    () => truncateForDisplay(descriptionSource, Number.MAX_SAFE_INTEGER),
    [descriptionSource],
  );
  const descriptionStandIn = identity.description === null;

  // ── The activity ladder ───────────────────────────────────────────────
  // The bare `Done` marker is filtered on the way in: it is the ABSENCE of a
  // beat, and the rest sentence says the same thing with facts in it.
  const beat =
    beats && pulse.enabled
      ? sessionActivityBeat(
          latestLineForScope(pulse.lines, sessionId, pulse.cleared.get(sessionId)),
        )
      : null;
  const restLine = sessionActivityRestLine({
    turnCount: facts?.turn_count ?? 0,
    fileSize: facts?.file_size ?? null,
    lastUsedAtMs: facts?.last_used_at ?? null,
  });
  const target: DisplayEntry =
    activityOverride !== null && activityOverride.length > 0
      ? composedEntry(activityOverride)
      : compacting
        ? COMPACTING_ENTRY
        : beat !== null
          ? { key: beat.key, text: beat.text, placeholder: false }
          : composedEntry(restLine);
  // Paced HERE rather than in a leaf, so a swap re-renders the row and
  // `TugPulse` measures the new text — see {@link useDwellDisplay}.
  const entry = useDwellDisplay(target, pace);

  // ── The row's own menu ────────────────────────────────────────────────
  // Fed the NEWEST beat rather than the one on screen: within a dwell window
  // the two differ by a line, and the newest is the honest thing to hand a
  // paste. The description item is offered for a written synopsis and for a
  // prompt standing in for one, but not for the created-on stamp, which is a
  // fact the row composed rather than anything the session said.
  const menu = useSessionIdentityMenu({
    identity,
    description:
      identity.description === null && prompt.length === 0 ? null : descriptionFull,
    activity: beat?.text ?? null,
    hostCardId,
    enabled: identityMenu,
  });
  const ActivityRun = markdown ? ActivityMarkdownText : ActivityText;
  const activity = (
    <ActivityRun
      entry={entry}
      highlight={highlight}
      className={activityClassName}
    />
  );

  // ── The tape ──────────────────────────────────────────────────────────
  // Unconditional wherever the mount asks for one — a session that has done no
  // work yet shows a FLATLINE, which is the instrument reading zero rather than
  // the instrument being absent. An accessory that comes and goes with the
  // data it reports is one the reader cannot trust: nothing on screen
  // distinguishes "this session is quiet" from "the tape is not here", and the
  // line beneath it moves out to the row's edge and back every time the
  // distinction flips. `pulse/enabled` does not gate it either, for the same
  // reason the activity line survives that toggle: chrome that got shorter
  // when a preference changed would move every card in the pane.
  const tapeNode = tape ? (
    <SessionActivitySparkline sessionId={sessionId} />
  ) : undefined;
  const sparkline =
    tapeNode !== undefined && renderTape !== undefined
      ? renderTape(tapeNode)
      : tapeNode;

  // The row's own dot leads the name line, so the identity renders its runs
  // only — one mark per row, never two.
  const runs = (
    <TugSessionIdentity
      identity={identity}
      tier="line"
      dot={false}
      highlight={highlight}
      // Where the row answers a right-click, the hover says nothing. Both were
      // showing the session's name and description over a row already showing
      // both, and only one of them can be acted on.
      tooltip={!identityMenu}
    />
  );

  return (
    <>
    <TugSessionRow
      // The row's own class, always, ahead of whatever the mount adds. A bare
      // `TugSessionRow` and one of these are the same element otherwise — same
      // `data-slot`, same classes — and `data-slot` cannot carry the difference
      // because the shape owns that name and this composes it rather than
      // replacing it. So: the one mark that says a row's parts came from the
      // stores rather than from a mount site's own hand.
      className={
        className !== undefined
          ? `${IDENTITY_ROW_CLASS} ${className}`
          : IDENTITY_ROW_CLASS
      }
      indicator={
        <SessionPhaseDot sessionId={sessionId} size={dotSize} drift={drift} />
      }
      indicatorSize={dotSize}
      name={nameProps !== undefined ? <span {...nameProps}>{runs}</span> : runs}
      description={renderFilterHighlight(description, highlight)}
      descriptionFull={descriptionFull}
      descriptionElided={description !== descriptionFull}
      descriptionStandIn={descriptionStandIn}
      activity={activity}
      sparkline={sparkline}
      {...rest}
      // After the mount's own props, deliberately: the row-wide menu is the
      // last word on the right-click, and the element the responder registers
      // on has to be this one. No mount site passes either today.
      ref={menu.ref as React.Ref<HTMLDivElement>}
      // CAPTURE, so the row is asked before anything inside it. The runs are
      // copyables in their own right — the title sits inside a `TugLabel`, and
      // a label is intrinsically copyable — so on the bubble the title's press
      // was claimed by the label and answered with Cut/Copy/Paste/Select All
      // over the label's text, which is the row's title spelled out rather
      // than the session. One menu for the row means the row is asked first.
      onContextMenuCapture={menu.onContextMenu}
    />
    {menu.contextMenu}
    </>
  );
}
