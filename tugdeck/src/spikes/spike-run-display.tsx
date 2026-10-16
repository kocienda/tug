/**
 * spike-run-display.tsx — what should a Bash block show while it runs a test
 * batch or a build, and what should it leave behind when the run is over?
 *
 * Today a reporting command (`just app-test`, `tugtool test run`, a recipe
 * calling `tugtool progress`) gets ONE monospace line on the block's live
 * band: `app-test · 3/25 · at0310-file-view-open.test.ts PASS (2/2) 5s`.
 * That line is the latest report and nothing else — the files already
 * landed, the ones in flight, the one that went red two minutes ago, the
 * projected finish, are all gone the moment the next report replaces it.
 * And when the call returns, the band vanishes and the reader is left with
 * the raw text report to scroll.
 *
 * The candidate is a **run panel**: a body the block grows while a reporting
 * command runs, that settles into the block's result when it is over. ONE
 * panel for every run; what differs between runs is the **unit** the
 * reporter counts, and the panel says which it is:
 *
 *   run           unit     counted by
 *   app-test      file     the recipe (one `.row` per file)
 *   rust / bun    test     `tugtool test run`, from the runner's lines
 *   build-app     phase    the recipe (cargo, vite, swift, sign)
 *
 * The panel's parts, top to bottom, in ONE column — a transcript block is
 * never wide enough for two, and a reader scrolls it:
 *
 *   1. A **masthead** — the ring the band already has, the label, the
 *      fraction WITH ITS UNIT (`4/25 files`, `812/1412 tests`), the tally
 *      as badges, elapsed, and a projection from the ledger's recorded times.
 *   2. The **tally track** — one cell per unit, coloured as it lands:
 *      pending, running, pass, fail, wedged, skipped. Up to 64 units the
 *      track is cells; past that it is a density band (done over total,
 *      fails as marks), because 1 400 cells is noise.
 *   3. **In flight** — one row per job slot: the unit it runs now, its
 *      elapsed against the recorded median, the wedge cap at the gauge's
 *      end. A wedge is visible BEFORE the recipe kills the file. A run with
 *      one job is one row; a build's phases are its rows (as step rows).
 *   4. **Reds, always open** — a failed or wedged unit stays on the panel
 *      from the moment it lands, with its first failure's title and message.
 *   5. **Folds** — everything that grows with the run is behind a
 *      disclosure, collapsed by default: the units that passed, the
 *      wall-time chart (one thin bar per unit, the recorded median as a
 *      ghost tick), and the diagnostics the tests asked to be seen.
 *   6. At the end a **verdict band** replaces the ring; the rest stays.
 *
 * What the display needs that the wire does not carry today: the reporter
 * posts one latest line (`label · text · done/total · failures`). A panel
 * needs the run's UNITS — each one's name, status, counts, seconds, first
 * failure, recorded median — plus the unit word and the job count. The last
 * section says what that frame would look like. Everything here is a frozen
 * frame over fixtures; nothing ticks.
 *
 * @module spikes/spike-run-display
 */

import "./spike.css";
import "./spike-run-display.css";

import React from "react";
import { Hammer } from "lucide-react";

import { TugAccordion, TugAccordionItem } from "@/components/tugways/tug-accordion";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugLinearGauge } from "@/components/tugways/tug-linear-gauge";
import { TugMetaRun } from "@/components/tugways/tug-meta-run";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugStepFraction } from "@/components/tugways/tug-step-fraction";
import { TugStepRow } from "@/components/tugways/tug-step-row";

import type { SpikeDef } from "./spike-registry";

// ---------------------------------------------------------------------------
// Fixtures — chunk c05 of the 2026-10-16 baseline sweep, as a frozen frame.
// ---------------------------------------------------------------------------

type UnitStatus = "pending" | "running" | "pass" | "fail" | "wedged" | "skipped";

interface Unit {
  name: string;
  status: UnitStatus;
  /** Tests passed / tests in the unit, once it has landed. */
  passed?: number;
  total?: number;
  /** Wall seconds so far (running) or at landing. */
  secs?: number;
  /** The ledger's median of the unit's last five recorded runs. */
  median?: number;
  /** A red unit's first failure: its title and first message line. */
  failure?: { title: string; message: string };
}

/** Past this many units the track is a density band rather than cells. */
const CELLS_UP_TO = 64;

const FILES: Unit[] = [
  { name: "at0277-jots-list-outline", status: "pass", passed: 3, total: 3, secs: 7, median: 6 },
  { name: "at0303-session-card-mount", status: "pass", passed: 2, total: 2, secs: 9, median: 8 },
  { name: "at0310-file-view-open", status: "pass", passed: 2, total: 2, secs: 5, median: 5 },
  {
    name: "at0339-composer-order-census",
    status: "fail",
    passed: 1,
    total: 2,
    secs: 14,
    median: 9,
    failure: {
      title: "composer clears after send",
      message: "clearComposer: data-empty wait timed out after 2000 ms",
    },
  },
  { name: "at0341-rail-focus-cycle", status: "running", secs: 12, median: 9 },
  { name: "at0352-pane-split-restore", status: "running", secs: 31, median: 11 },
  { name: "at0360-session-identity-menu", status: "running", secs: 4, median: 7 },
  { name: "at0366-commit-atom-pill", status: "running", secs: 2, median: 6 },
  { name: "at0372-changes-shade-rows", status: "pending", median: 8 },
  { name: "at0381-ask-dialog-height", status: "pending", median: 12 },
  { name: "at0390-window-menu-sidebar", status: "pending", median: 6 },
  { name: "at0402-theme-swap-paint", status: "pending", median: 10 },
  { name: "at0415-transcript-copy-atoms", status: "pending", median: 9 },
  { name: "at0427-fold-interior-still", status: "pending", median: 23 },
  { name: "at0432-list-view-activate", status: "pending", median: 7 },
  { name: "at0450-body-view-edges", status: "pending", median: 15 },
  { name: "at0477-pane-chrome-grain", status: "pending", median: 8 },
  { name: "at0492-apptest-tripwire", status: "pending", median: 11 },
  { name: "at0526-commit-mention-pill", status: "pending", median: 6 },
  { name: "at0527-jot-keeps-chips", status: "pending", median: 9 },
  { name: "at0572-arc-lane-chords", status: "pending", median: 12 },
  { name: "at0588-hand-back", status: "skipped", median: 20 },
  { name: "at0605-composer-bottom", status: "pending", median: 8 },
  { name: "at0696-fold-settle", status: "pending", median: 18 },
  { name: "at0706-unfold-settle", status: "pending", median: 19 },
];

/** The same batch, as it ended: two reds, one wedge, 4m 12s on the wall. */
const FINISHED: Unit[] = FILES.map((u) => {
  if (u.status !== "running" && u.status !== "pending") return u;
  if (u.name === "at0352-pane-split-restore") {
    return { ...u, status: "wedged", passed: 0, total: 3, secs: 120 };
  }
  if (u.name === "at0450-body-view-edges") {
    return {
      ...u,
      status: "fail",
      passed: 2,
      total: 4,
      secs: 29,
      failure: {
        title: "body edge reads the shell colour",
        message: "expected rgb(28,30,36) at (811, 402), read rgb(41,44,52)",
      },
    };
  }
  const total = 2 + (u.name.length % 3);
  return { ...u, status: "pass", passed: total, total, secs: (u.median ?? 8) + (u.name.length % 4) };
});

/** The `note()` lines the tests asked to be seen. */
const DIAGNOSTICS: { unit: string; lines: string[] }[] = [
  { unit: "at0427-fold-interior-still", lines: ["settle frames: 14, first beat 62 ms, no mid-motion gap"] },
  { unit: "at0450-body-view-edges", lines: ["body edge sampled at 3 points: 2 shell, 1 body"] },
  { unit: "at0696-fold-settle", lines: ["fold: 18 frames over 302 ms; lead 41 ms"] },
];

const JOBS = 4;

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function fmtSecs(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The letter a status wears, so colour is never the only reading. */
const MARK: Record<UnitStatus, string> = {
  pending: "·",
  running: "›",
  pass: "✓",
  fail: "✗",
  wedged: "⏱",
  skipped: "–",
};

const WORD: Record<UnitStatus, string> = {
  pending: "pending",
  running: "running",
  pass: "PASS",
  fail: "FAIL",
  wedged: "WEDGED",
  skipped: "skipped",
};

function plural(n: number, unit: string): string {
  return n === 1 ? unit : `${unit}s`;
}

/** The fraction and the word for what it counts: `4/25 files`. */
function Fraction({ done, total, unit }: { done: number; total: number; unit: string }) {
  return (
    <span className="srd-fraction">
      <TugStepFraction current={done} total={total} />
      <span className="srd-unit">{plural(total, unit)}</span>
    </span>
  );
}

/**
 * The tally track. Up to {@link CELLS_UP_TO} units it is one cell per unit
 * in run order — a `data-status` the CSS paints and a title for the
 * pointer. Past that it is a density band: done over total, fails as marks.
 */
function TallyTrack({ units, dense = false }: { units: Unit[]; dense?: boolean }) {
  if (units.length > CELLS_UP_TO) return <DensityBand units={units} />;
  return (
    <div className="srd-track" data-dense={dense ? "" : undefined} role="img" aria-label="run tally">
      {units.map((u) => (
        <span
          key={u.name}
          className="srd-cell"
          data-status={u.status}
          title={`${u.name} · ${WORD[u.status]}${u.secs !== undefined ? ` · ${u.secs}s` : ""}`}
        />
      ))}
    </div>
  );
}

function DensityBand({ units }: { units: Unit[] }) {
  const total = units.length;
  const done = units.filter((u) => u.status === "pass" || u.status === "fail").length;
  const fails = units.map((u, i) => (u.status === "fail" ? i : -1)).filter((i) => i >= 0);
  return (
    <div className="srd-band-track" role="img" aria-label={`${done} of ${total} done, ${fails.length} failed`}>
      <span className="srd-band-fill" style={{ width: `${(done / total) * 100}%` }} />
      {fails.map((i) => (
        <span key={i} className="srd-band-fail" style={{ left: `${(i / total) * 100}%` }} title={units[i]!.name} />
      ))}
    </div>
  );
}

function Tally({ units }: { units: Unit[] }) {
  const n = (s: UnitStatus) => units.filter((u) => u.status === s).length;
  const pass = n("pass");
  const fail = n("fail");
  const wedged = n("wedged");
  const skipped = n("skipped");
  return (
    <div className="srd-tally">
      <TugBadge role="success" emphasis="tinted" size="xs">{pass} pass</TugBadge>
      {fail > 0 && <TugBadge role="danger" emphasis="filled" size="xs">{fail} fail</TugBadge>}
      {wedged > 0 && <TugBadge role="caution" emphasis="tinted" size="xs">{wedged} wedged</TugBadge>}
      {skipped > 0 && <TugBadge role="inherit" emphasis="outlined" size="xs">{skipped} skipped</TugBadge>}
    </div>
  );
}

/**
 * One job slot: the unit it runs now, its elapsed against its median, the
 * wedge cap at the gauge's end. The readout reads as one phrase —
 * `31s of ~11s` — and the cap sits under the gauge's far end where it is.
 */
function Lane({ unit }: { unit: Unit }) {
  const median = unit.median ?? 8;
  const cap = Math.max(120, median * 3);
  const secs = unit.secs ?? 0;
  return (
    <div className="srd-lane" data-over={secs > median ? "" : undefined}>
      <TugProgressIndicator variant="pulsing-dot" size={10} state="running" role="action" aria-label="running" />
      <span className="srd-lane-name">{unit.name}</span>
      <div className="srd-lane-gauge" title={`wedge cap ${fmtSecs(cap)}: 3× the recorded median, floored at 2m`}>
        <TugLinearGauge
          value={secs}
          min={0}
          max={cap}
          thresholds={{ caution: median, danger: median * 2 }}
          density="compact"
          formatValue={(v) => `${v}s of ~${median}s`}
        />
        <span className="srd-lane-cap">cap {fmtSecs(cap)}</span>
      </div>
    </div>
  );
}

/** A landed unit: mark, name, and `PASS · 2/2 · 5s (~5s)`. */
function LandedRow({ unit }: { unit: Unit }) {
  const slow = unit.median !== undefined && unit.secs !== undefined && unit.secs > unit.median * 1.5;
  return (
    <div className="srd-landed" data-status={unit.status}>
      <span className="srd-mark" aria-hidden>{MARK[unit.status]}</span>
      <span className="srd-landed-name">{unit.name}</span>
      <TugMetaRun
        parts={[
          <span key="w" className="srd-word">{WORD[unit.status]}</span>,
          unit.total !== undefined ? <span key="c">{unit.passed}/{unit.total}</span> : null,
          unit.secs !== undefined ? (
            <span key="s" data-over={slow ? "" : undefined}>
              {unit.secs}s{unit.median !== undefined ? ` (~${unit.median}s)` : ""}
            </span>
          ) : null,
        ]}
      />
    </div>
  );
}

/** A red unit, always open: head, first failure, ledger history. */
function RedCard({ unit }: { unit: Unit }) {
  const history = unit.name.startsWith("at0339")
    ? "history: red in the last 7 recorded runs (batches of 25, 25, 1, 25, 22, 25, 25)"
    : unit.status === "wedged"
      ? "history: a WEDGED row is a machine state, not a result — relaunch"
      : "history: last green 6ad15611d (today, 1 run ago, batch of 25)";
  return (
    <div className="srd-fail-card" data-status={unit.status}>
      <div className="srd-fail-head">
        <span className="srd-mark" aria-hidden>{MARK[unit.status]}</span>
        <span className="srd-landed-name">{unit.name}</span>
        <TugBadge role={unit.status === "wedged" ? "caution" : "danger"} emphasis="tinted" size="2xs">{WORD[unit.status]}</TugBadge>
        <span className="srd-spacer" />
        <span className="srd-fail-secs">{unit.secs}s (~{unit.median}s)</span>
      </div>
      {unit.failure ? (
        <>
          <div className="srd-failure-title">{unit.failure.title}</div>
          <div className="srd-failure-msg">{unit.failure.message}</div>
        </>
      ) : (
        <div className="srd-failure-msg">
          stopped at its 120s cap (3× the median of its recent recorded times, 11s) — the app stopped answering
        </div>
      )}
      <div className="srd-history">{history}</div>
    </div>
  );
}

/** Per-unit wall time as thin horizontal bars in run order, the median a ghost tick. */
function DurationChart({ units }: { units: Unit[] }) {
  const landed = units.filter((u) => u.secs !== undefined);
  const max = Math.max(...landed.map((u) => Math.max(u.secs ?? 0, u.median ?? 0)));
  return (
    <div className="srd-durations" role="img" aria-label="wall time per unit">
      {landed.map((u) => (
        <div key={u.name} className="srd-dur-row" data-status={u.status} title={`${u.name} · ${u.secs}s (median ${u.median}s)`}>
          <span className="srd-dur-name">{u.name}</span>
          <span className="srd-dur-track">
            <span className="srd-dur-bar" style={{ width: `${((u.secs ?? 0) / max) * 100}%` }} />
            {u.median !== undefined && <span className="srd-dur-tick" style={{ left: `${(u.median / max) * 100}%` }} />}
          </span>
          <span className="srd-dur-val">{u.secs}s</span>
        </div>
      ))}
    </div>
  );
}

/** A fold's trigger: a name and a count, at the section-title register. */
function FoldTitle({ label, count }: { label: string; count: number | string }) {
  return (
    <span className="srd-fold-title">
      <span>{label}</span>
      <span className="srd-fold-count">{count}</span>
    </span>
  );
}

function BlockHead({ cmd, time, red = false }: { cmd: string; time: string; red?: boolean }) {
  return (
    <div className="srd-block-head">
      <span className="srd-dot" data-red={red ? "" : undefined} data-live={red ? undefined : ""} />
      <span className="srd-block-verb">Bash</span>
      <code className="srd-block-cmd">{cmd}</code>
      <span className="srd-block-time">{time}</span>
    </div>
  );
}

const CMD = "TUG_APPTEST_SELECTION=baseline just app-test $(cat /tmp/baseline-chunks/c05) 2>&1";

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** The block as it ships: the one line on the live band. */
function Today() {
  return (
    <div className="srd-block">
      <BlockHead cmd={CMD} time="0m 21s" />
      <div className="srd-band">
        <TugProgressIndicator variant="ring" size={12} role="action" state="running" value={3} max={25} aria-label="Progress" />
        <span className="srd-band-text">app-test · 3/25 · at0310-file-view-open.test.ts PASS (2/2) 5s</span>
      </div>
    </div>
  );
}

/** Candidate, mid-run: 4 landed, 4 in flight, one already red. */
function RunningPanel() {
  const reds = FILES.filter((u) => u.status === "fail" || u.status === "wedged");
  const greens = FILES.filter((u) => u.status === "pass").reverse();
  const running = FILES.filter((u) => u.status === "running");
  const done = reds.length + greens.length;
  return (
    <div className="srd-block">
      <BlockHead cmd={CMD} time="0m 21s" />
      <div className="srd-panel" data-state="running">
        <div className="srd-masthead">
          <TugProgressIndicator variant="ring" size={22} role="action" state="running" value={done} max={FILES.length} aria-label="Progress" />
          <span className="srd-label">app-test</span>
          <Fraction done={done} total={FILES.length} unit="file" />
          <Tally units={FILES} />
          <span className="srd-spacer" />
          <TugMetaRun
            parts={[
              <span key="j">{JOBS} jobs</span>,
              <span key="e">0m 21s</span>,
              <span key="p" className="srd-projection" title="from the ledger's recorded medians, divided by the job count">
                ~4m 10s to go
              </span>,
            ]}
          />
        </div>

        <TallyTrack units={FILES} />

        <div className="srd-lanes">
          {running.map((u) => <Lane key={u.name} unit={u} />)}
        </div>

        {reds.map((u) => <RedCard key={u.name} unit={u} />)}

        <TugAccordion type="multiple" variant="plain" className="srd-folds">
          <TugAccordionItem value="passed" trigger={<FoldTitle label="Passed" count={greens.length} />}>
            <div className="srd-landed-list">
              {greens.map((u) => <LandedRow key={u.name} unit={u} />)}
            </div>
          </TugAccordionItem>
        </TugAccordion>
      </div>
    </div>
  );
}

/** Candidate, at rest: the verdict band, the tally, the reds, the folds. */
function FinishedPanel() {
  const reds = FINISHED.filter((u) => u.status === "fail" || u.status === "wedged");
  const greens = FINISHED.filter((u) => u.status === "pass");
  return (
    <div className="srd-block">
      <BlockHead cmd={CMD} time="4m 12s" red />
      <div className="srd-panel" data-state="red">
        <div className="srd-verdict" data-verdict="red">
          <span className="srd-verdict-word">RED</span>
          <span className="srd-verdict-text">2 of 25 files failed, 1 wedged · 24 run, 1 skipped · 4m 12s</span>
          <span className="srd-spacer" />
          <span className="srd-verdict-history" title="apptest_results.db: the batch at the base checkout, 2026-10-15">
            base: 1 red (at0339, 7 runs)
          </span>
        </div>

        <div className="srd-masthead">
          <span className="srd-label">app-test</span>
          <Fraction done={24} total={25} unit="file" />
          <Tally units={FINISHED} />
          <span className="srd-spacer" />
          <TugMetaRun parts={[<span key="j">{JOBS} jobs</span>, <span key="w">wall 4m 12s</span>, <span key="h">history 3m 48s</span>]} />
        </div>

        <TallyTrack units={FINISHED} />

        {reds.map((u) => <RedCard key={u.name} unit={u} />)}

        <TugAccordion type="multiple" variant="plain" className="srd-folds">
          <TugAccordionItem value="passed" trigger={<FoldTitle label="Passed" count={greens.length} />}>
            <div className="srd-landed-list">
              {greens.map((u) => <LandedRow key={u.name} unit={u} />)}
            </div>
          </TugAccordionItem>
          <TugAccordionItem value="wall" trigger={<FoldTitle label="Wall time" count="ghost tick is the recorded median" />}>
            <DurationChart units={FINISHED} />
          </TugAccordionItem>
          <TugAccordionItem value="diag" trigger={<FoldTitle label="Diagnostics" count={DIAGNOSTICS.length} />}>
            <div className="srd-diag">
              {DIAGNOSTICS.map((d) => (
                <div key={d.unit} className="srd-diag-unit">
                  <span className="srd-landed-name">{d.unit}</span>
                  {d.lines.map((l) => <span key={l} className="srd-diag-line">{l}</span>)}
                </div>
              ))}
            </div>
          </TugAccordionItem>
        </TugAccordion>
      </div>
    </div>
  );
}

/** The same panel over the other two unit kinds: a test, and a phase. */
function OtherRuns() {
  const nextestTotal = 1412;
  const nextestDone = 812;
  // A synthetic unit list big enough to cross CELLS_UP_TO, so the track
  // takes its band form through the same component.
  const tests: Unit[] = Array.from({ length: nextestTotal }, (_, i) => ({
    name: `test ${i}`,
    status: i < nextestDone ? (i === 437 ? "fail" : "pass") : "pending",
  }));
  return (
    <div className="srd-stack">
      <div className="srd-panel" data-state="running">
        <div className="srd-masthead">
          <TugProgressIndicator variant="ring" size={22} role="action" state="running" value={nextestDone} max={nextestTotal} aria-label="Progress" />
          <span className="srd-label">rust</span>
          <Fraction done={nextestDone} total={nextestTotal} unit="test" />
          <Tally units={[{ name: "x", status: "pass" }, { name: "y", status: "fail" }]} />
          <span className="srd-spacer" />
          <TugMetaRun parts={[<span key="j">1 job</span>, <span key="e">1m 04s</span>, <span key="p" className="srd-projection">~0m 50s to go</span>]} />
        </div>
        <TallyTrack units={tests} />
        <div className="srd-lanes">
          <div className="srd-lane">
            <TugProgressIndicator variant="pulsing-dot" size={10} state="running" role="action" aria-label="running" />
            <span className="srd-lane-name">tugcast::session_index::index_write_is_telemetry</span>
          </div>
        </div>
        <RedCard
          unit={{
            name: "tugcast::feeds::jots::reopen_keeps_chips",
            status: "fail",
            secs: 0,
            median: 0,
            failure: { title: "assertion failed: chips.len() == 2", message: "left: 1, right: 2 — tugrust/crates/tugcast/src/jots.rs:131" },
          }}
        />
      </div>

      <div className="srd-panel" data-state="running">
        <div className="srd-masthead">
          <Hammer size={16} className="srd-icon" aria-hidden />
          <span className="srd-label">build-app</span>
          <Fraction done={2} total={4} unit="phase" />
          <span className="srd-spacer" />
          <TugMetaRun parts={[<span key="e">1m 38s</span>, <span key="p" className="srd-projection">~0m 30s to go</span>]} />
        </div>
        <TallyTrack
          units={[
            { name: "cargo build --release", status: "pass" },
            { name: "vite build", status: "pass" },
            { name: "swift build", status: "running" },
            { name: "codesign + bundle", status: "pending" },
          ]}
        />
        <div className="srd-phases">
          <TugStepRow status="done" label="cargo build --release" detail="tugcast · tugtool · tugexec — 61s (~58s)" />
          <TugStepRow status="done" label="vite build" detail="tugdeck/dist — 14s (~15s)" />
          <TugStepRow status="busy" label="swift build" detail="compiling TestHarness — 23s of ~30s" />
          <TugStepRow status="pending" label="codesign + bundle" detail="~8s" />
        </div>
      </div>
    </div>
  );
}

/** What the live band reads as while the block is COLLAPSED: the strip. */
function CollapsedStrip() {
  return (
    <div className="srd-block">
      <BlockHead cmd="just app-test $(cat /tmp/baseline-chunks/c05)" time="0m 21s" />
      <div className="srd-band srd-strip">
        <TugProgressIndicator variant="ring" size={12} role="action" state="running" value={4} max={25} aria-label="Progress" />
        <span className="srd-label">app-test</span>
        <Fraction done={4} total={25} unit="file" />
        <TallyTrack units={FILES} dense />
        <TugBadge role="danger" emphasis="filled" size="2xs">1 fail</TugBadge>
        <span className="srd-spacer" />
        <span className="srd-band-text">~4m 10s to go</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The spike
// ---------------------------------------------------------------------------

function SpikeRunDisplay(): React.ReactElement {
  return (
    <div className="sp-content srd">
      <section className="sp-section">
        <h2 className="sp-section-title">Today — the one line</h2>
        <p className="srd-blurb">
          The latest report, and nothing before it. A red file two minutes back is gone; the files in flight are
          invisible; the finish is a guess.
        </p>
        <Today />
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">One panel, one column, one rule for the unit</h2>
        <p className="srd-blurb">
          Every run counts <b>units</b>; the reporter says which, and the fraction names it. The panel is the same for
          all three. The only thing that changes with the count is the track&rsquo;s form: cells up to {CELLS_UP_TO}{" "}
          units, a density band past that.
        </p>
        <table className="srd-legend">
          <thead>
            <tr><th>run</th><th>unit</th><th>counted by</th><th>in flight</th><th>track</th></tr>
          </thead>
          <tbody>
            <tr><td>app-test</td><td>file</td><td>the recipe, one row per file</td><td>one lane per job</td><td>25 cells</td></tr>
            <tr><td>rust · bun</td><td>test</td><td><code>tugtool test run</code>, from the runner&rsquo;s lines</td><td>the test running now</td><td>1 412 → band</td></tr>
            <tr><td>build-app</td><td>phase</td><td>the recipe, one row per phase</td><td>the phase as a step row</td><td>4 cells</td></tr>
          </tbody>
        </table>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Candidate — mid-run</h2>
        <p className="srd-blurb">
          Masthead, track, the four job <b>lanes</b> (elapsed of median, the wedge cap at the end — <code>at0352</code>{" "}
          is past 2× and about to be killed), then the <b>reds, always open</b>. What passed is behind a fold.
        </p>
        <RunningPanel />
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Candidate — finished red</h2>
        <p className="srd-blurb">
          The ring yields to a verdict band. The reds stay open with their ledger history. Passed, wall time (ghost
          tick = recorded median) and diagnostics are three folds, collapsed, in the one column.
        </p>
        <FinishedPanel />
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">The same panel over a test and a phase</h2>
        <p className="srd-blurb">
          A nextest run: 1 412 units cross the cell limit through the same component, so the track is a band with the
          one fail as a mark; one job, so one lane. A build: four phases, four cells, and the lanes are step rows.
        </p>
        <OtherRuns />
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Collapsed — the strip</h2>
        <p className="srd-blurb">
          With the block folded, the live band is all there is: ring, label, fraction with its unit, the track at 5px
          cells, the fail count, the projection.
        </p>
        <CollapsedStrip />
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">What the wire would have to carry</h2>
        <div className="srd-wire">
          <p className="srd-blurb">
            Today&rsquo;s <code>run_progress</code> frame is the latest line: <code>label · text · done/total ·
            failures</code>. The panel needs the run&rsquo;s <b>units</b> and the word for them:
          </p>
          <pre className="srd-pre">{`{ "op": "run_progress", "tool_use_id": "…", "label": "app-test",
  "unit": "file", "jobs": 4, "done": 4, "total": 25, "failures": 1,
  "units": [
    { "name": "at0339-composer-order-census", "status": "fail",
      "passed": 1, "total": 2, "secs": 14, "median": 9,
      "failure": { "title": "composer clears after send",
                   "message": "clearComposer: data-empty wait timed out" } },
    { "name": "at0352-pane-split-restore", "status": "running", "secs": 31, "median": 11 }
  ] }`}</pre>
          <p className="srd-blurb">
            <code>tugtool progress</code> grows <code>--unit file</code> and <code>--row name:status:passed/total:secs</code>;
            the recipe already knows every field (its <code>.row</code> files and <code>wedge_cap_for</code>).{" "}
            <code>tugtool test run</code> posts <code>unit: test</code> rows from the per-test lines it already parses.
            The deck keeps units per call in <code>RunProgressStore</code>, capped, and the panel is one more{" "}
            <code>useSyncExternalStore</code> leaf.
          </p>
        </div>
      </section>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "run-display",
  title: "Run Display",
  blurb: "What should a Bash block show while it runs a test batch or a build, and leave behind when it is over?",
  icon: "Activity",
  size: { min: { width: 520, height: 400 }, preferred: { width: 820, height: 720 } },
  component: () => <SpikeRunDisplay />,
};
