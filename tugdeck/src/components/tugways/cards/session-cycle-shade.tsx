/**
 * SessionCycleShade — what the Session card's shade shows of a cycle of
 * several entries.
 *
 * Top to bottom: a header with the lowering control, the word `Cycle`, the
 * cycle's name and how much of it has landed; the cycle's map in a well; a
 * Back bar while two or more assets are selected; the asset list; and a
 * two-line footer saying what this session is running now and what is ready
 * next. The list is the only scroller, with a tail under its last asset so
 * that asset too can reach the top. The map never moves: a press on it
 * selects, and the list answers by scrolling the pressed asset to its top.
 *
 * Each asset appears once. A sketch is its letter, the entries it heads and
 * its text whole. An entry is its number, its arc, the session running it
 * when that is another session, its brief, what it waits on, its note, how it
 * stands, and its steps while it runs. Nothing here starts an arc.
 *
 * The selection is this component's: a press on a tile or a seal selects one,
 * a shift-press adds or removes one, and a press on the map's ground clears.
 * One selected leaves the list whole; two or more narrow it to those. A host
 * that shows another cycle remounts this component by key, which clears it.
 *
 * Everything shown is read from `session-cycle-shade-model`; this component
 * composes `CycleMap`, `TugListRow`, `TugArcAtom`, `TugAtomRef`, `TugBadge`,
 * `ArcLifecycleMark`, `ArcStepItems`, `SessionCitation` and `TugPushButton`
 * and draws nothing of its own.
 *
 * Laws: [L02] the frame's arc rows and the line store enter through
 *       `useSyncExternalStore`, [L06] selected, narrowed and met are `data-*`
 *       the CSS paints, [L11] the lowering control and the Back bar emit and
 *       the host owns the shade's state, [L13] the list's scroll to an asset
 *       is CSS `scroll-behavior`, [L16] pairings declared, [L19] component
 *       authoring guide, [L20] owns `--tugx-cycle-shade-*`; composed children
 *       keep their tokens, [L24] the selection is local data, since the list
 *       it narrows reads it
 *
 * @module components/tugways/cards/session-cycle-shade
 */

import "./session-cycle-shade.css";

import React, { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { ArcLifecycleMark } from "@/components/tugways/arc-lifecycle-mark";
import { ArcStepItems } from "@/components/tugways/arc-step-list";
import { CycleMap } from "@/components/tugways/cycle-map";
import { headsOf, NO_PICKS, pickOnMap, sketchKey } from "@/components/tugways/cycle-map-layout";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";
import { TugAtomRef } from "@/components/tugways/tug-atom-ref";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugPopupListFrame, TugPopupListScroller } from "@/components/tugways/tug-popup-list";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { arcTrackModelFromEntry } from "@/lib/arc-track-model";
import { useChangesetAll } from "@/lib/changeset-all-store";
import type { CycleSketchWire, CycleWire } from "@/lib/changeset-types";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { sessionLineStore } from "@/lib/session-line-store";

import { recordPanel } from "./session-arc-record-panel";
import { ArcShadeLowerContext } from "./session-arc-shade";
import {
  arcRowsByOwner,
  cycleAssetKeys,
  cycleListView,
  cycleMapSketches,
  cycleMapTiles,
  cycleShadeEntries,
  cycleShadeSummary,
  type CycleShadeEntry,
  type CycleShadeSummary,
} from "./session-cycle-shade-model";
import { SessionCitation } from "./session-identity";

export interface SessionCycleShadeProps {
  /** The cycle shown: one entry or more. */
  cycle: CycleWire;
  /** The card's session segment, or null while it has none. */
  sessionId: string | null;
  /** The owner key of the arc this session is bound to, or null. */
  boundOwnerId: string | null;
  /** Lower the shade: the header's control. */
  onLower: () => void;
  /**
   * The live body of the arc this session is bound to: its steps and its
   * verbs. Drawn in that arc's entry in place of the plain step list, so the
   * entry that is this session's work is also where it is stopped and landed.
   */
  hereBody?: React.ReactNode;
  /** That arc's brief, by its headings, drawn in the same entry. */
  hereBrief?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/** How an entry stands, at its row's trailing edge. */
function EntryMark({ read }: { read: CycleShadeEntry }): React.ReactElement | null {
  const { entry, row } = read;
  if (entry.state === "joined") {
    return (
      <TugBadge size="xs" emphasis="ghost" role="success">
        Joined
      </TugBadge>
    );
  }
  if (entry.state === "ready") {
    return (
      <TugBadge size="xs" emphasis="tinted" role="action">
        Ready
      </TugBadge>
    );
  }
  if (entry.state === "dropped") {
    return (
      <TugBadge size="xs" emphasis="ghost" role="inherit">
        Dropped
      </TugBadge>
    );
  }
  if (entry.state !== "running") return null;
  if (row === null) {
    return (
      <TugBadge size="xs" emphasis="ghost" role="action">
        Running
      </TugBadge>
    );
  }
  return <ArcLifecycleMark model={arcTrackModelFromEntry(row)} name={row.display_name} size="rail" showWord />;
}

/** What an entry waits on, as the numbers the map's tiles wear. */
function Waits({ read }: { read: CycleShadeEntry }): React.ReactElement | null {
  const { entry, openWaits } = read;
  if (entry.waits.length === 0 || entry.state === "joined" || entry.state === "dropped") return null;
  return (
    <span className="session-cycle-shade-waits" data-slot="session-cycle-shade-waits">
      <span>Waits on</span>
      {entry.waits.map((n) => {
        const met = !openWaits.includes(n);
        return (
          <span key={n} className="session-cycle-shade-wait" data-met={met || undefined}>
            {n}
            {met ? <Check size={10} aria-hidden /> : null}
          </span>
        );
      })}
    </span>
  );
}

/** A sketch in the list: whole, with the entries it heads. */
function SketchAsset({
  sketch,
  heads,
  selected,
  onChoose,
}: {
  sketch: CycleSketchWire;
  heads: readonly number[];
  selected: boolean;
  onChoose: (key: string) => void;
}): React.ReactElement {
  const key = sketchKey(sketch.letter);
  return (
    <div
      className="session-cycle-shade-asset"
      data-slot="session-cycle-shade-asset"
      data-asset={key}
      data-kind="sketch"
      data-chosen={selected || undefined}
    >
      <TugListRow
        selected={selected}
        leading={<span className="session-cycle-shade-seal">{sketch.letter}</span>}
        title={<span className="session-cycle-shade-sketch-label">{`Sketch ${sketch.letter}`}</span>}
        trailing={
          heads.length > 0 ? (
            <span className="session-cycle-shade-waits">
              <span>Heads</span>
              {heads.map((n) => (
                <span key={n} className="session-cycle-shade-wait" data-met>
                  {n}
                </span>
              ))}
            </span>
          ) : undefined
        }
        trailingReveal="always"
        onClick={() => onChoose(key)}
      />
      <div className="session-cycle-shade-sketch-body">{recordPanel(sketch.text).body}</div>
    </div>
  );
}

/** An entry in the list: everything about it, in one place. */
function EntryAsset({
  read,
  selected,
  onChoose,
  hereBody,
  hereBrief,
}: {
  read: CycleShadeEntry;
  selected: boolean;
  onChoose: (key: string) => void;
  hereBody?: React.ReactNode;
  hereBrief?: React.ReactNode;
}): React.ReactElement {
  const { entry, key, where, row } = read;
  const steps = row?.steps ?? [];
  return (
    <div
      className="session-cycle-shade-asset"
      data-slot="session-cycle-shade-asset"
      data-asset={key}
      data-kind="entry"
      data-state={entry.state}
      data-chosen={selected || undefined}
    >
      <TugListRow
        selected={selected}
        leading={<span className="session-cycle-shade-number">{entry.n}</span>}
        title={
          <span className="session-cycle-shade-title">
            {entry.arc !== undefined ? (
              <TugArcAtom name={entry.arc.name} />
            ) : (
              <span>{entry.brief_title ?? entry.brief}</span>
            )}
            {where === "elsewhere" && entry.bound_session !== undefined ? (
              <SessionCitation citedId={entry.bound_session} recordedTag={entry.bound_callsign ?? null} />
            ) : where === "here" ? (
              <TugLabel size="2xs" emphasis="calm">
                this session
              </TugLabel>
            ) : null}
          </span>
        }
        description={
          <span className="session-cycle-shade-facts">
            {entry.brief_path !== undefined ? (
              <TugAtomRef entity={{ kind: "file", path: entry.brief_path }} />
            ) : (
              <span className="session-cycle-shade-quiet">{entry.brief}</span>
            )}
            <Waits read={read} />
            {entry.note !== undefined && entry.state !== "joined" ? (
              <span className="session-cycle-shade-note">{entry.note}</span>
            ) : null}
          </span>
        }
        trailing={
          <span className="session-cycle-shade-trailing">
            <EntryMark read={read} />
          </span>
        }
        trailingReveal="always"
        onClick={() => onChoose(key)}
      />
      {hereBody !== undefined ? (
        <div className="session-cycle-shade-here" data-slot="session-cycle-shade-here">
          {hereBody}
          {hereBrief}
        </div>
      ) : entry.state === "running" && row !== null && steps.length > 0 ? (
        <div className="session-cycle-shade-steps" data-slot="session-cycle-shade-steps">
          <TugPopupListFrame kind="item" layout="inline">
            <TugPopupListScroller>
              <ArcStepItems steps={steps} live={arcTrackModelFromEntry(row).live} />
            </TugPopupListScroller>
          </TugPopupListFrame>
        </div>
      ) : entry.state === "joined" ? (
        <p className="session-cycle-shade-asset-line">Landed. Its rounds and commit stay on record.</p>
      ) : entry.state === "dropped" ? (
        <p className="session-cycle-shade-asset-line">Dropped. Starting its brief again brings it back.</p>
      ) : null}
    </div>
  );
}

/** Two lines: what this session is doing now, and what is ready next. */
function Footer({ summary }: { summary: CycleShadeSummary }): React.ReactElement {
  const { now, next, elsewhere, elsewhereSessions } = summary;
  const nowRow = now.kind === "entry" ? now.entry.row : null;
  return (
    <div className="session-cycle-shade-footer" data-slot="session-cycle-shade-footer">
      <div className="session-cycle-shade-footer-line" data-line="now">
        <span className="session-cycle-shade-footer-word">Now</span>
        {now.kind === "entry" ? (
          <span className="session-cycle-shade-footer-what">
            {now.entry.entry.arc !== undefined ? <TugArcAtom name={now.entry.entry.arc.name} /> : null}
            {nowRow !== null ? (
              <ArcLifecycleMark
                model={arcTrackModelFromEntry(nowRow)}
                name={nowRow.display_name}
                size="rail"
                showWord
              />
            ) : null}
          </span>
        ) : (
          <span className="session-cycle-shade-quiet">{now.text}</span>
        )}
        <span className="session-cycle-shade-spacer" />
        {elsewhere > 0 ? (
          <span className="session-cycle-shade-footer-else">
            {elsewhereSessions.length === 0 ? (
              elsewhere === 1 ? (
                "1 more in another session"
              ) : (
                `${elsewhere} more in other sessions`
              )
            ) : (
              <>
                <span>{`${elsewhere} more in`}</span>
                {elsewhereSessions.map((s) => (
                  <SessionCitation key={s.id} citedId={s.id} recordedTag={s.tag} />
                ))}
              </>
            )}
          </span>
        ) : null}
      </div>
      <div className="session-cycle-shade-footer-line" data-line="next">
        <span className="session-cycle-shade-footer-word">Next</span>
        {next.kind === "entry" ? (
          <span className="session-cycle-shade-footer-what">
            {next.entry.entry.arc !== undefined ? (
              <TugArcAtom name={next.entry.entry.arc.name} />
            ) : (
              <span>{next.entry.entry.brief_title ?? next.entry.entry.brief}</span>
            )}
            {next.note !== null ? (
              <span className="session-cycle-shade-note">{next.note}</span>
            ) : next.more > 0 ? (
              <span className="session-cycle-shade-quiet">{`and ${next.more} more ready`}</span>
            ) : null}
          </span>
        ) : (
          <span className="session-cycle-shade-quiet">{next.text}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

export function SessionCycleShade({
  cycle,
  sessionId,
  boundOwnerId,
  onLower,
  hereBody,
  hereBrief,
}: SessionCycleShadeProps): React.ReactElement {
  const aggregate = useChangesetAll();
  // Here and elsewhere are read through the session's line, which moves on
  // its own beat.
  const lines = useSyncExternalStore(sessionLineStore.subscribe, sessionLineStore.getVersion);
  const arcRows = useMemo(() => arcRowsByOwner(aggregate), [aggregate]);
  const entries = useMemo(
    () => cycleShadeEntries(cycle, { sessionId, boundOwnerId, arcRows }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `lines` is the invalidation key: here and elsewhere are read from the line store
    [cycle, sessionId, boundOwnerId, arcRows, lines],
  );
  const tiles = useMemo(() => cycleMapTiles(entries), [entries]);
  const seals = useMemo(() => cycleMapSketches(cycle), [cycle]);
  const summary = useMemo(() => cycleShadeSummary(cycle, entries), [cycle, entries]);
  const keys = useMemo(() => cycleAssetKeys(cycle), [cycle]);
  const sources = useMemo(
    () => cycle.entries.map((e) => ({ n: e.n, waits: e.waits, from: e.from ?? [] })),
    [cycle],
  );

  // The frame's focus seat for the lowering control: the key view lands here
  // when the shade rises, since this form has no Done to land on.
  const lowerSeat = useContext(ArcShadeLowerContext);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(NO_PICKS);
  const view = cycleListView(keys, chosen);

  // A press on the map asks the list to bring the pressed asset to its top.
  // The scroll runs after the commit, since the selection decides which
  // assets the list holds. Only the list scrolls, so the map and the point
  // pressed hold still.
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollOwed = useRef(false);
  const pressOnMap = useCallback((key: string, shift: boolean) => {
    scrollOwed.current = true;
    setChosen((prev) => pickOnMap(prev, key, shift));
  }, []);
  const clear = useCallback(() => setChosen(NO_PICKS), []);
  useLayoutEffect(() => {
    if (!scrollOwed.current) return;
    scrollOwed.current = false;
    const list = listRef.current;
    if (list === null) return;
    const asset = view.top !== null ? list.querySelector<HTMLElement>(`[data-asset="${view.top}"]`) : null;
    list.scrollTo({ top: asset !== null ? asset.offsetTop : 0 });
  });

  // A press on a row in the whole list selects it; in a narrowed list the
  // selection is kept.
  const narrowed = view.narrowed;
  const chooseRow = useCallback(
    (key: string) => {
      if (!narrowed) setChosen(new Set([key]));
    },
    [narrowed],
  );

  const entryByKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const sketchByKey = useMemo(
    () => new Map((cycle.sketches ?? []).map((s) => [sketchKey(s.letter), s])),
    [cycle],
  );

  return (
    <div
      className="session-cycle-shade"
      data-slot="session-cycle-shade"
      data-narrowed={narrowed || undefined}
      data-cycle={cycle.id}
    >
      <div className="session-cycle-shade-header" data-slot="session-cycle-shade-header">
        <TugTooltip content="Lower the cycle">
          <TugPushButton
            size="xs"
            subtype="icon"
            emphasis="ghost"
            icon={<ChevronDown size={16} />}
            aria-label="Lower the cycle"
            focusGroup={lowerSeat?.focusGroup}
            focusOrder={lowerSeat?.focusOrder}
            onClick={onLower}
          />
        </TugTooltip>
        <span className="session-cycle-shade-eyebrow">Cycle</span>
        <span className="session-cycle-shade-name" data-slot="session-cycle-shade-name">
          {summary.name}
        </span>
        <span className="session-cycle-shade-spacer" />
        <span className="session-cycle-shade-landed" data-slot="session-cycle-shade-landed">
          {summary.landedText}
        </span>
      </div>
      <CycleMap
        className="session-cycle-shade-map"
        tiles={tiles}
        sketches={seals}
        size="full"
        chosen={chosen}
        onPress={pressOnMap}
        onClear={clear}
      />
      {narrowed ? (
        <div className="session-cycle-shade-back" data-slot="session-cycle-shade-back">
          <TugPushButton size="2xs" subtype="text" emphasis="outlined" onClick={clear}>
            Back
          </TugPushButton>
          <TugLabel size="2xs" emphasis="calm">
            {`Showing ${view.shown.length} · Shift-click to add or remove, click the map's ground to clear`}
          </TugLabel>
        </div>
      ) : null}
      <div className="session-cycle-shade-list" data-slot="session-cycle-shade-list" ref={listRef}>
        {view.shown.map((key) => {
          const read = entryByKey.get(key);
          if (read !== undefined) {
            const here = read.where === "here";
            return (
              <EntryAsset
                key={key}
                read={read}
                selected={chosen.has(key)}
                onChoose={chooseRow}
                hereBody={here ? hereBody : undefined}
                hereBrief={here ? hereBrief : undefined}
              />
            );
          }
          const sketch = sketchByKey.get(key);
          return sketch !== undefined ? (
            <SketchAsset
              key={key}
              sketch={sketch}
              heads={headsOf(sketch.letter, sources)}
              selected={chosen.has(key)}
              onChoose={chooseRow}
            />
          ) : null;
        })}
        {narrowed ? null : <div className="session-cycle-shade-list-tail" aria-hidden />}
      </div>
      <Footer summary={summary} />
    </div>
  );
}
