/**
 * usage-sheet.tsx — the `/usage` sheet: subscription limits + contribution
 * breakdown + this session's cost, at parity with Claude Code's terminal
 * `/usage`.
 *
 * The panel is owned by the `claude` CLI (it fetches the account-global limit
 * windows from its usage endpoint and computes the local-session contribution
 * characteristics itself). Rather than reimplement that, the app-level
 * {@link UsageStore} shells `claude -p "/usage"` on open and parses the text
 * into {@link UsageData}; this sheet renders it graphically:
 *
 *   - the limit windows as gauges — the session window is the `TugArcGauge`
 *     hero, each weekly window a `TugLinearGauge`, with reset captions;
 *   - the "What's contributing to your limits" periods (Last 24h / Last 7d)
 *     with their characteristics and top skills / subagents / plugins tables;
 *   - a **Session** block (cost, durations, tokens) folded from this card's
 *     transcript via {@link deriveSessionTotals} — the live-session figures the
 *     interactive terminal panel also shows.
 *
 * Compositional — composes `TugSheet` (via the card's shared `showSheet`),
 * `TugSheetScaffold`, `TugArcGauge`, `TugLinearGauge`, `TugPushButton`;
 * composed children keep their own tokens ([L20]). Store reads go through
 * `useSyncExternalStore` ([L02]); appearance is CSS ([L06]).
 *
 * Laws: [L02] store reads via `useSyncExternalStore`, [L06] appearance via CSS,
 *       [L20] composed children keep tokens.
 * Decisions: [D15] pane sheets are overlays.
 *
 * @module components/tugways/cards/usage-sheet
 */

import "./usage-sheet.css";

import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugArcGauge } from "@/components/tugways/tug-arc-gauge";
import { TugLinearGauge } from "@/components/tugways/tug-linear-gauge";
import type { GaugeThresholds } from "@/components/tugways/gauge-math";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import { TugSheetScaffold } from "@/components/tugways/tug-sheet-scaffold";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import {
  formatDurationMs,
  formatTokensCaps,
} from "@/components/tugways/cards/session-card-telemetry-renderers";
import type { UsageStore } from "@/lib/usage-store";
import type {
  UsageData,
  UsagePeriod,
  UsageTableEntry,
  UsageWindow,
} from "@/lib/usage-parse";
import type { CodeSessionStore } from "@/lib/code-session-store";
import { deriveSessionTotals } from "@/lib/code-session-store/telemetry";
import { MODAL_REST_LINE } from "./modal-rest-line";

/** Shared caution/danger fractions for the limit gauges. */
const USAGE_THRESHOLDS: GaugeThresholds = { caution: 0.75, danger: 0.9 };

// ---------------------------------------------------------------------------
// useUsageSheet — the card-hosted /usage sheet
// ---------------------------------------------------------------------------

export interface UseUsageSheetArgs {
  /** App-level usage-panel store; `null` outside the provider. */
  usageStore: UsageStore | null;
  /** This card's session store — source of the Session cost/token totals. */
  codeSessionStore: CodeSessionStore;
  /** The card's shared sheet host (`useTugSheet().showSheet`). */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
}

export interface UsageSheetController {
  /**
   * Present the `/usage` sheet, firing a fresh (or cached) panel request — or,
   * when this sheet is the one already showing, dismiss it. `/usage` and ⌃⌘U
   * are the same door in both directions.
   */
  openUsageSheet: () => void;
}

export function useUsageSheet({
  usageStore,
  codeSessionStore,
  showSheet,
}: UseUsageSheetArgs): UsageSheetController {
  // Is *this* sheet the one currently mounted, and how do we close it? The
  // shared sheet host is single-slot, so `showSheet`'s promise resolving is the
  // authoritative "no longer showing" signal — it fires on Done, on Escape, and
  // on another sheet superseding this one. `closeRef` is the body's own `close`
  // callback, registered while it is mounted.
  const shownRef = useRef(false);
  const closeRef = useRef<(() => void) | null>(null);

  const openUsageSheet = useCallback(() => {
    if (shownRef.current) {
      closeRef.current?.();
      return;
    }
    usageStore?.requestUsage();
    shownRef.current = true;
    void showSheet({
      title: "Usage",
      icon: "Gauge",
      // Two fixed columns (a 200px meter column and a 170px-min label column)
      // plus their values, so the table needs more than a single-column form.
      displayWidth: "lg",
      presentation: "rise",
      bottomAnchorSelector: MODAL_REST_LINE,
      content: (close) => (
        <UsageSheetBody
          usageStore={usageStore}
          codeSessionStore={codeSessionStore}
          onClose={close}
          registerClose={closeRef}
        />
      ),
    }).then(() => {
      shownRef.current = false;
      closeRef.current = null;
    });
  }, [usageStore, codeSessionStore, showSheet]);

  return { openUsageSheet };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Session cost — cents to two places, sub-cent to four so a tiny run isn't `$0.00`. */
function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Tidy a reset caption. `claude` prints "resets Jul 13 at 11:20am
 * (America/Los_Angeles)"; capitalize and drop the timezone parenthetical, which
 * is noise in the graphical panel.
 */
function formatReset(resetText: string): string {
  const stripped = resetText.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** Is this the session (5-hour) window — the arc-gauge hero? */
function isSessionWindow(w: UsageWindow): boolean {
  return /session/i.test(w.label);
}

/**
 * Trim a characteristic clause for a gauge label so the readout reads
 * naturally after the percent: "of your usage was at >150k context" →
 * "at >150k context" (the gauge renders "91% at >150k context").
 */
function characteristicLabel(text: string): string {
  return text
    .replace(/^of your usage\s+/i, "")
    .replace(/^(was|came)\s+/i, "");
}

// ---------------------------------------------------------------------------
// Sheet body
// ---------------------------------------------------------------------------

interface UsageSheetBodyProps {
  usageStore: UsageStore | null;
  codeSessionStore: CodeSessionStore;
  onClose: (value?: string) => void;
  /** Hands this sheet's `close` back to the controller, for the ⌃⌘U re-press. */
  registerClose: React.MutableRefObject<(() => void) | null>;
}

function UsageSheetBody({
  usageStore,
  codeSessionStore,
  onClose,
  registerClose,
}: UsageSheetBodyProps): React.ReactElement {
  const usage = useSyncExternalStore(
    useCallback(
      (onChange) => (usageStore ? usageStore.subscribe(onChange) : () => {}),
      [usageStore],
    ),
    useCallback(
      () =>
        usageStore
          ? usageStore.getSnapshot()
          : ({ phase: "idle", requestId: null, data: null, rawText: null, error: null } as const),
      [usageStore],
    ),
  );
  const transcript = useSyncExternalStore(
    codeSessionStore.subscribe,
    useCallback(() => codeSessionStore.getSnapshot().transcript, [codeSessionStore]),
  );
  const totals = useMemo(() => deriveSessionTotals(transcript), [transcript]);

  useEffect(() => {
    registerClose.current = () => onClose();
    return () => {
      registerClose.current = null;
    };
  }, [registerClose, onClose]);

  // The ⌃⌘U half of the toggle that the card cannot answer. `usage` is a
  // key-card-routed command, and while a sheet is up there is no key card —
  // the sheet's responder is portalled out of the card's subtree, so the walk
  // finds no `card` ancestor and the dispatch lands nowhere. It is still
  // *announced*: `notifyDispatchObservers` runs whether or not a responder
  // handled it. So the open panel watches the chain for its own command and
  // takes the second press as "put me away".
  const manager = useResponderChain();
  useEffect(() => {
    if (manager === null) return;
    return manager.observeDispatch((event) => {
      if (event.action !== TUG_ACTIONS.RUN_SLASH_COMMAND) return;
      const value = event.value as { name?: string } | undefined;
      if (value?.name !== "usage") return;
      onClose();
    });
  }, [manager, onClose]);

  const doneFocusGroup = React.useId();
  useSeedKeyView(`${doneFocusGroup}:0`);

  const data = usage.data;
  const loading = usage.phase === "loading" && data === null;

  return (
    <TugSheetScaffold
      className="usage-sheet"
      footer={
        <div className="usage-sheet-footer">
          {usageStore !== null ? (
            <TugPushButton
              size="sm"
              emphasis="outlined"
              onClick={() => usageStore.requestUsage(true)}
              disabled={usage.phase === "loading"}
              data-testid="usage-refresh"
            >
              Refresh
            </TugPushButton>
          ) : (
            <span />
          )}
          <TugPushButton
            size="sm"
            emphasis="primary"
            onClick={() => onClose()}
            data-testid="usage-done"
            focusGroup={doneFocusGroup}
            focusOrder={0}
          >
            Done
          </TugPushButton>
        </div>
      }
    >
      <div className="usage-sheet-body">
        {loading ? (
          <p className="usage-sheet-notice" role="status">
            Loading usage…
          </p>
        ) : usage.phase === "error" && data === null ? (
          <p className="usage-sheet-notice" role="alert">
            {usage.error ?? "Couldn't load usage."}
          </p>
        ) : (
          <>
            <UsageLimits data={data} totals={totals} />
            <UsageContributing data={data} />
          </>
        )}
      </div>
    </TugSheetScaffold>
  );
}

// ---------------------------------------------------------------------------
// Limits (gauges) + Session summary — the top region
// ---------------------------------------------------------------------------

function UsageLimits({
  data,
  totals,
}: {
  data: UsageData | null;
  totals: ReturnType<typeof deriveSessionTotals>;
}): React.ReactElement {
  const windows = data?.windows ?? [];
  const hero = windows.find(isSessionWindow) ?? windows[0] ?? null;
  const rest = windows.filter((w) => w !== hero);

  return (
    <section className="usage-sheet-top" aria-label="Subscription limits">
      <div className="usage-sheet-hero">
        {hero !== null ? (
          <>
            <TugArcGauge
              min={0}
              max={100}
              value={hero.percent}
              density="detailed"
              thresholds={USAGE_THRESHOLDS}
              formatValue={(v) => `${Math.round(v)}%`}
              label={hero.label}
            />
            <div className="usage-sheet-hero-reset">{formatReset(hero.resetText)}</div>
          </>
        ) : (
          <p className="usage-sheet-notice" role="status">
            No limit data reported.
          </p>
        )}
      </div>

      <div className="usage-sheet-side">
        {rest.length > 0 ? (
          <div className="usage-sheet-windows">
            {rest.map((w) => (
              <div className="usage-sheet-window" key={w.label}>
                <div className="usage-sheet-window-label">{w.label}</div>
                <TugLinearGauge
                  className="usage-sheet-gauge"
                  min={0}
                  max={100}
                  value={w.percent}
                  thresholds={USAGE_THRESHOLDS}
                  formatValue={(v) => `${Math.round(v)}%`}
                />
                <div className="usage-sheet-window-reset">{formatReset(w.resetText)}</div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="usage-sheet-section-title">Session</div>
        <div className="usage-sheet-grid">
          <div className="usage-sheet-grid-col">
            <UsageStat label="Cost" value={formatUsd(totals.totalCostUsd)} />
            <UsageStat label="Active" value={formatDurationMs(totals.totalActiveMs)} />
            <div className="usage-sheet-grid-divider" />
            <UsageStat label="Input" value={formatTokensCaps(totals.totalInputTokens)} />
            <UsageStat label="Cache read" value={formatTokensCaps(totals.totalCacheReadTokens)} />
          </div>
          <div className="usage-sheet-grid-col">
            <UsageStat label="Turns" value={String(totals.turnCount)} />
            <UsageStat label="Wall clock" value={formatDurationMs(totals.totalWallClockMs)} />
            <div className="usage-sheet-grid-divider" />
            <UsageStat label="Output" value={formatTokensCaps(totals.totalOutputTokens)} />
            <UsageStat label="Cache write" value={formatTokensCaps(totals.totalCacheCreationTokens)} />
          </div>
        </div>
      </div>
    </section>
  );
}

/** One label → value pair (with a dotted leader between) in the Session grid. */
function UsageStat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <>
      <span className="usage-sheet-stat-label">{label}</span>
      <span className="usage-sheet-leader" aria-hidden />
      <span className="usage-sheet-num usage-sheet-stat-value">{value}</span>
    </>
  );
}

// ---------------------------------------------------------------------------
// Contributing — the "What's contributing to your limits" periods
// ---------------------------------------------------------------------------

function UsageContributing({ data }: { data: UsageData | null }): React.ReactElement | null {
  const periods = data?.periods ?? [];
  if (periods.length === 0) return null;
  return (
    <section className="usage-sheet-contributing" aria-label="What's contributing to your limits">
      <div className="usage-sheet-section-title">What's contributing to your limits</div>
      {data?.contributingCaveat !== null && data?.contributingCaveat !== undefined ? (
        <p className="usage-sheet-caveat">{data.contributingCaveat}</p>
      ) : null}
      <div className="usage-sheet-periods">
        {periods.map((p) => (
          <UsagePeriodBlock key={p.label} period={p} />
        ))}
      </div>
    </section>
  );
}

function UsagePeriodBlock({ period }: { period: UsagePeriod }): React.ReactElement {
  const meta: string[] = [];
  if (period.requests !== null) meta.push(`${period.requests.toLocaleString()} requests`);
  if (period.sessions !== null) meta.push(`${period.sessions.toLocaleString()} sessions`);
  return (
    <div className="usage-sheet-period">
      <div className="usage-sheet-period-head">
        <span className="usage-sheet-period-label">{period.label}</span>
        {meta.length > 0 ? (
          <span className="usage-sheet-period-meta">{meta.join(" · ")}</span>
        ) : null}
      </div>

      {period.characteristics.length > 0 ? (
        <div className="usage-sheet-chars">
          {period.characteristics.map((c) => (
            <div className="usage-sheet-char" key={c.text}>
              <div className="usage-sheet-char-label">{characteristicLabel(c.text)}</div>
              <TugLinearGauge
                className="usage-sheet-gauge usage-sheet-char-gauge"
                min={0}
                max={100}
                value={c.percent}
                thresholds={USAGE_THRESHOLDS}
                formatValue={(v) => `${Math.round(v)}%`}
              />
            </div>
          ))}
        </div>
      ) : null}

      <div className="usage-sheet-tables">
        <UsageTable title="Skills" entries={period.skills} />
        <UsageTable title="Subagents" entries={period.subagents} />
        <UsageTable title="Plugins" entries={period.plugins} />
      </div>
    </div>
  );
}

function UsageTable({
  title,
  entries,
}: {
  title: string;
  entries: UsageTableEntry[];
}): React.ReactElement | null {
  if (entries.length === 0) return null;
  return (
    <div className="usage-sheet-table">
      <div className="usage-sheet-table-head">
        <span className="usage-sheet-table-title">{title}</span>
        <span className="usage-sheet-table-col">% of usage</span>
      </div>
      {entries.map((e) => (
        <div className="usage-sheet-table-row" key={e.name}>
          <span className="usage-sheet-table-name">{e.name}</span>
          <span className="usage-sheet-table-dots" aria-hidden />
          <span className="usage-sheet-num usage-sheet-table-pct">{e.percent}%</span>
        </div>
      ))}
    </div>
  );
}
