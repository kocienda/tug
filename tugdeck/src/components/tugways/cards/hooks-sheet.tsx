/**
 * hooks-sheet.tsx — the `/hooks` read-only accordion sheet ([#step-12c]).
 *
 * `/hooks` shows the hook configuration from Claude Code's `settings.json`
 * files, mirroring CC's `/hooks`: a "N hooks configured" header, a read-only
 * notice, and a `TugAccordion` with one item per hook event (trigger = event
 * name + count + one-line description; body = the configured matcher groups /
 * commands, or an empty note). Read-only — to change hooks you edit
 * `settings.json` (or ask Claude); there is no editor here.
 *
 * Sourcing is single-shot, not a feed: {@link useHooksSheet} fires a
 * `hooks_query` on open (and on the in-sheet refresh) via
 * {@link HooksInventoryStore}, and the body renders the matching response read
 * through `useSyncExternalStore` ([L02]). The event list comes from
 * {@link selectHookEventRows} — the static catalog joined with the configured
 * counts, plus any configured-but-uncatalogued events.
 *
 * Compositional — composes `TugSheet` (via the card's shared `showSheet`),
 * `TugSheetScaffold`, `TugAccordion`, `TugPushButton`, `TugLabel`; composed
 * children keep their own tokens ([L20]).
 *
 * Laws: [L02] store reads via `useSyncExternalStore`, [L06] appearance via
 *       CSS, [L20] composed children keep tokens.
 * Decisions: [D15] pane sheets are overlays.
 *
 * @module components/tugways/cards/hooks-sheet
 */

import "./hooks-sheet.css";

import React, { useCallback, useMemo, useSyncExternalStore } from "react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugAccordion, TugAccordionItem } from "@/components/tugways/tug-accordion";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import { TugSheetScaffold } from "@/components/tugways/tug-sheet-scaffold";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import {
  type HookEventRow,
  type HookMatcherGroup,
  type HooksInventoryStore,
  countHooks,
  hooksSummaryLine,
  selectHookEventRows,
} from "@/lib/hooks-inventory-store";
import { MODAL_REST_LINE } from "./modal-rest-line";

// ---------------------------------------------------------------------------
// useHooksSheet — the card-hosted /hooks sheet
// ---------------------------------------------------------------------------

export interface UseHooksSheetArgs {
  /** Store that fires `hooks_query` and resolves the reply. */
  hooksInventoryStore: HooksInventoryStore;
  /** The card's shared sheet host (`useTugSheet().showSheet`). */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
}

export interface HooksSheetController {
  /** Present the `/hooks` sheet, firing a fresh request for this session. */
  openHooksSheet: () => void;
}

export function useHooksSheet({
  hooksInventoryStore,
  showSheet,
}: UseHooksSheetArgs): HooksSheetController {
  const openHooksSheet = useCallback(() => {
    hooksInventoryStore.requestHooks();
    void showSheet({
      title: "Hooks",
      icon: "Webhook",
      displayWidth: "lg",
      presentation: "rise",
      bottomAnchorSelector: MODAL_REST_LINE,
      content: (close) => (
        <HooksSheetBody hooksInventoryStore={hooksInventoryStore} onClose={close} />
      ),
    });
  }, [hooksInventoryStore, showSheet]);

  return { openHooksSheet };
}

// ---------------------------------------------------------------------------
// Event row — one accordion item: trigger (name + count) over matcher groups
// ---------------------------------------------------------------------------

/** The collapsed trigger: event name, a count badge, and the description. */
function EventTrigger({ row }: { row: HookEventRow }): React.ReactElement {
  return (
    <span className="hooks-sheet-trigger">
      <span className="hooks-sheet-event">{row.name}</span>
      {row.count > 0 ? (
        <span className="hooks-sheet-count">{row.count}</span>
      ) : null}
      {row.description.length > 0 ? (
        <span className="hooks-sheet-event-desc">{row.description}</span>
      ) : null}
    </span>
  );
}

/** One matcher group: the matcher pattern over its commands. */
function MatcherGroup({ group }: { group: HookMatcherGroup }): React.ReactElement {
  return (
    <div className="hooks-sheet-group">
      <div className="hooks-sheet-matcher">
        {group.matcher !== undefined && group.matcher.length > 0
          ? `Matcher: ${group.matcher}`
          : "All tools"}
      </div>
      {group.hooks.map((cmd, i) => (
        <div key={i} className="hooks-sheet-cmd">
          <code className="hooks-sheet-cmd-text">
            {cmd.command ?? cmd.type}
          </code>
          {cmd.timeout !== undefined ? (
            <span className="hooks-sheet-cmd-timeout">timeout {cmd.timeout}s</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The expanded body: the event's matcher groups, or an empty note. */
function EventBody({ row }: { row: HookEventRow }): React.ReactElement {
  if (row.groups.length === 0) {
    return (
      <p className="hooks-sheet-empty-event" role="note">
        No hooks configured for this event.
      </p>
    );
  }
  return (
    <div className="hooks-sheet-groups">
      {row.groups.map((group, i) => (
        <MatcherGroup key={i} group={group} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sheet body — header + read-only notice + the per-event accordion
// ---------------------------------------------------------------------------

interface HooksSheetBodyProps {
  hooksInventoryStore: HooksInventoryStore;
  onClose: (value?: string) => void;
}

function HooksSheetBody({
  hooksInventoryStore,
  onClose,
}: HooksSheetBodyProps): React.ReactElement {
  const snapshot = useSyncExternalStore(
    hooksInventoryStore.subscribe,
    hooksInventoryStore.getSnapshot,
  );
  const refresh = useCallback(
    () => hooksInventoryStore.requestHooks(),
    [hooksInventoryStore],
  );
  // Author the controls into the sheet's trapped focus mode: Tab walks the event
  // accordion → Done, with Done seeded as the live default (filled+ring) on open.
  const focusGroup = React.useId();
  const ACCORDION_ORDER = 0;
  const DONE_ORDER = 1;
  useSeedKeyView(`${focusGroup}:${DONE_ORDER}`);

  const events = snapshot.payload?.events ?? {};
  const rows = useMemo(() => selectHookEventRows(events), [events]);
  const total = useMemo(() => countHooks(events), [events]);
  const ready = snapshot.phase === "ready" && snapshot.payload !== null;

  let body: React.ReactElement;
  if (snapshot.phase === "error") {
    body = (
      <p className="hooks-sheet-notice" role="alert">
        {snapshot.error ?? "Couldn't load hooks."}
      </p>
    );
  } else if (snapshot.phase === "loading" || snapshot.payload === null) {
    body = (
      <p className="hooks-sheet-notice" role="status">
        Loading hooks…
      </p>
    );
  } else {
    body = (
      <TugAccordion
        type="multiple"
        variant="separator"
        className="hooks-sheet-list"
        focusGroup={focusGroup}
        focusOrder={ACCORDION_ORDER}
      >
        {rows.map((row) => (
          <TugAccordionItem
            key={row.name}
            value={row.name}
            trigger={<EventTrigger row={row} />}
            data-testid="hook-event"
          >
            <EventBody row={row} />
          </TugAccordionItem>
        ))}
      </TugAccordion>
    );
  }

  const header = (
    <div className="hooks-sheet-header">
      <div className="hooks-sheet-header-text">
        {ready ? (
          <span className="hooks-sheet-summary">{hooksSummaryLine(total)}</span>
        ) : null}
        <TugLabel emphasis="calm" size="sm">
          Read-only — edit settings.json (or ask Claude) to add or change hooks.
        </TugLabel>
      </div>
      <div className="hooks-sheet-header-actions">
        <TugPushButton
          size="sm"
          emphasis="ghost"
          onClick={refresh}
          disabled={snapshot.phase === "loading"}
          data-testid="hooks-refresh"
        >
          Refresh
        </TugPushButton>
      </div>
    </div>
  );

  return (
    <TugSheetScaffold
      className="hooks-sheet"
      header={header}
      footer={
        <div className="tug-sheet-actions">
          <TugPushButton
            size="sm"
            emphasis="primary"
            onClick={() => onClose()}
            data-testid="hooks-done"
            focusGroup={focusGroup}
            focusOrder={DONE_ORDER}
          >
            Done
          </TugPushButton>
        </div>
      }
    >
      {body}
    </TugSheetScaffold>
  );
}
