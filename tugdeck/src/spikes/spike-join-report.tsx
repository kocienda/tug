/**
 * spike-join-report.tsx — can the three rows an arc's landing leaves in the
 * transcript (the Wheel's finish receipt, the `Git Commit` entry, and the
 * `Joined` boundary) read as ONE report rather than two summaries and an
 * empty row?
 *
 * What ships today, in order: a `Wheel` entry carrying the arc's record
 * (`Finished · 2 stages`, the brief it opened on, one row per stage); a `Git
 * Commit` entry whose body is EMPTY, because the join boundary it contains
 * pulls itself out to the transcript's edge; and under that, the `Joined`
 * boundary carrying the commit's sha and subject on its bar with the commit
 * receipt folded behind it. So the commit's content left the entry that is
 * named for it, the arc's record and the join's record sit in two places, and
 * the subsidiary text in both receipts was sized off the entry's timestamp —
 * provenance type worn by substantive lines.
 *
 * The candidate puts each thing back where its kind lives:
 *
 *   1. The `Git Commit` entry carries the commit receipt — the same
 *      `SessionCommitReceiptBlock` a `/commit` on the main lane gets, sha pill
 *      and subject on the header, message and file list beneath, expanded by
 *      default. A join IS a commit on the base; it reads like one.
 *   2. The `Joined` boundary keeps the compaction's anatomy exactly (rule,
 *      sunken bar, glyph, bold event, trailing badges, chevron) and folds the
 *      ARC's record behind it — the lifecycle strip, the brief, the stages
 *      with their cost — which is what the Wheel entry carried. One fold, one
 *      summary.
 *   3. The Wheel's finish moment shrinks to a quiet arc-note line, the seat
 *      every other arc gesture already has.
 *
 * And a type-scale correction that rides all three: the record's rows and
 * the quiet line read at the boundary event's own size, unbolded, rather
 * than at the timestamp's.
 *
 * @module spikes/spike-join-report
 */

import "./spike.css";
import type { SpikeDef } from "./spike-registry";
import "./spike-join-report.css";

import React from "react";
import { GitMerge, Layers, ShipWheel } from "lucide-react";

import { ArcLifecycleBlock } from "@/components/tugways/arc-lifecycle-block";
import { SessionBoundary } from "@/components/tugways/cards/session-boundary";
import {
  SessionArcReceiptBlock,
  parseArcReceipt,
  trackModelFor,
} from "@/components/tugways/cards/session-arc-receipt-block";
import { SessionCommitReceiptBlock } from "@/components/tugways/cards/session-commit-receipt-block";
import { SessionJoinReceiptBlock } from "@/components/tugways/cards/session-join-receipt-block";
import type { CommandBlockProps } from "@/components/tugways/cards/session-command-block-registry";
import {
  TugTranscriptEntry,
  type Participant,
} from "@/components/tugways/tug-transcript-entry";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import { TugQuietLine } from "@/components/tugways/tug-quiet-line";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";

// ---------------------------------------------------------------------------
// Fixtures — the landing of `copy-paste-fidelity`, as it happened.
// ---------------------------------------------------------------------------

const ROOT = "/Users/kocienda/Mounts/u/src/tug";
const ARC = "copy-paste-fidelity";
const BRIEF = ".tug/arcs/copy-paste-fidelity/brief.md";
const SHA = "133eae39bed04de122d5e6897abc0bd086a0f95d";
const ROUNDS = 10;
const SUBJECT = "tugarc(copy-paste-fidelity): Keep a copied atom an atom through every door";

const MESSAGE_BODY =
  "An atom drawn anywhere in Tug now copies as an atom and pastes back as the same atom in every Tug editor, and it survives what the destination does with it afterwards. A commit pill selected in a transcript arrives in the prompt entry as a live pill instead of two broken code spans, and a file chip pasted into a jot is still that chip after the jot is closed, reopened, and the app relaunched.\n\n" +
  "The identity a copy reads — data-atom-type, -label, -value and -id — is authored in one function, `lib/atom-identity-attrs.ts`, and spread by every renderer that draws an atom. It used to be a spread each caller remembered, and the two mounts that forgot it were the reports.\n\n" +
  "One table now answers what an atom looks like as plain text. `lib/atom-plain-text.ts` holds it and the three writers that disagreed all read it, so a commit is `commit:<8>` wherever it was copied from rather than a markdown link with a sha for a URL.\n\n" +
  "Tug-Session: kind-visor (65969484)\n" +
  "Tug-Session-Id: 68ebb98b-c6dc-4395-954d-f7c7f2cdb595\n" +
  "Tug-Arc: tugarc/copy-paste-fidelity onto main";

/** The landed files, from the commit's own numstat. */
const NUMSTAT = `17\t5\ttests/app-test/at0043-tug-text-editor-copy-diag.test.ts
1\t0\ttests/app-test/at0477-transcript-copy-atoms.test.ts
338\t0\ttests/app-test/at0526-commit-mention-copies-as-pill.test.ts
624\t0\ttests/app-test/at0527-jot-keeps-its-chips.test.ts
390\t0\ttests/app-test/at0528-receipt-commit-copies-as-atom.test.ts
109\t0\ttugdeck/src/__tests__/jots-doc.test.ts
24\t7\ttugdeck/src/components/jots/jots-card.tsx
170\t0\ttugdeck/src/components/tugways/__tests__/atom-identity-attributes.test.tsx
38\t0\ttugdeck/src/components/tugways/__tests__/tug-prompt-entry-strip-and-migrate.test.ts
8\t3\ttugdeck/src/components/tugways/__tests__/tug-text-editor-clipboard.test.ts
4\t5\ttugdeck/src/components/tugways/cards/tug-atom-markdown-body.tsx
1\t3\ttugdeck/src/components/tugways/cards/tug-atom-text-body.tsx
167\t0\ttugdeck/src/components/tugways/chrome/session-question-dialog.test.ts
129\t13\ttugdeck/src/components/tugways/chrome/session-question-dialog.tsx
53\t9\ttugdeck/src/components/tugways/commit-identity-menu.tsx
20\t11\ttugdeck/src/components/tugways/session-identity-menu.tsx
17\t1\ttugdeck/src/components/tugways/tug-commit-atom.tsx
50\t11\ttugdeck/src/components/tugways/tug-message-editor.tsx
60\t22\ttugdeck/src/components/tugways/tug-prompt-entry.tsx
9\t3\ttugdeck/src/components/tugways/tug-session-identity.tsx
143\t0\ttugdeck/src/components/tugways/tug-text-editor/capture-substrate.test.ts
6\t5\ttugdeck/src/components/tugways/tug-text-editor/clipboard-filters.ts
46\t5\ttugdeck/src/components/tugways/tug-text-editor/drop-extension.ts
37\t20\ttugdeck/src/components/tugways/tug-text-editor/keymap.ts
1\t1\ttugdeck/src/components/tugways/use-annotation-menu.tsx
166\t0\ttugdeck/src/lib/__tests__/atom-plain-text.test.ts
78\t0\ttugdeck/src/lib/__tests__/atom-text.test.ts
129\t0\ttugdeck/src/lib/__tests__/jot-drag.test.ts
14\t4\ttugdeck/src/lib/annotator/__tests__/atom-segment.test.ts
4\t0\ttugdeck/src/lib/annotator/__tests__/registry.test.ts
12\t12\ttugdeck/src/lib/annotator/atom-segment.ts
6\t0\ttugdeck/src/lib/annotator/registry.ts
88\t0\ttugdeck/src/lib/atom-identity-attrs.ts
93\t0\ttugdeck/src/lib/atom-plain-text.ts
82\t21\ttugdeck/src/lib/atom-text.ts
12\t4\ttugdeck/src/lib/code-session-store.ts
26\t6\ttugdeck/src/lib/code-session-store/__tests__/code-session-store.jot-insert.test.ts
2\t0\ttugdeck/src/lib/code-session-store/events.ts
6\t1\ttugdeck/src/lib/code-session-store/reducer.ts
3\t0\ttugdeck/src/lib/code-session-store/types.ts
25\t5\ttugdeck/src/lib/copy-clipboard.ts
58\t7\ttugdeck/src/lib/jot-drag.ts
117\t3\ttugdeck/src/lib/jots-doc.ts
12\t3\ttugdeck/src/lib/jots-store.ts
148\t0\ttugdeck/src/lib/markdown/__tests__/merge-adjacent-runs.test.ts
75\t7\ttugdeck/src/lib/markdown/serialize-selection.ts
18\t7\ttugdeck/src/lib/tug-atom-chip.tsx
15\t10\ttugdeck/src/lib/tug-atom-img.ts
37\t14\ttugdeck/src/lib/tug-text-types.ts
1\t0\ttugrust/crates/tugcast/src/feeds/jots.rs
138\t0\ttugrust/crates/tugcast/src/jots.rs`;

interface FileRow {
  path: string;
  status: string;
  added: number;
  removed: number;
}

const FILES: FileRow[] = NUMSTAT.split("\n").map((line) => {
  const [added, removed, path] = line.split("\t");
  const a = Number(added);
  const r = Number(removed);
  // A file with nothing removed and a fresh spelling is a creation; the
  // approximation is fine for a fixture — the receipt renders the word only.
  const status = r === 0 && a > 20 ? "created" : "modified";
  return { path: path ?? "", status, added: a, removed: r };
});
const ADDED = FILES.reduce((n, f) => n + f.added, 0);
const REMOVED = FILES.reduce((n, f) => n + f.removed, 0);

/** The S01 join receipt the `/arc-join` verb writes. */
const JOIN_OUTPUT =
  `joined ${SHA} · ${ARC} → main · ${ROUNDS} round(s)\n` +
  `fit: verified 7c1a02de onto e147f32f\n` +
  `files: ${JSON.stringify(FILES)}\n` +
  `${SUBJECT}\n\n${MESSAGE_BODY}`;

/** The S02 commit receipt a `/commit` writes — the same facts, the commit's own shape. */
const COMMIT_OUTPUT =
  `committed ${SHA} · ${FILES.length} file(s) · +${ADDED} −${REMOVED}\n` +
  `files: ${JSON.stringify(FILES)}\n` +
  `${SUBJECT}\n\n${MESSAGE_BODY}`;

/** The arc's record, as `format_arc_receipt` writes it for a finished arc. */
const ARC_OUTPUT =
  `arc complete · ${ARC}\n` +
  `opened on ${BRIEF}\n` +
  `implement · opus[1m] · 68ebb98b-c6dc-4395-954d-f7c7f2cdb595\n` +
  `audit · opus · 9d1c0f6e-2b3a-4c5d-8e7f-a1b2c3d4e5f6`;

function parseOrThrow(output: string): NonNullable<ReturnType<typeof parseArcReceipt>> {
  const parsed = parseArcReceipt(output);
  if (parsed === null) throw new Error("spike-join-report: arc fixture failed to parse");
  return parsed;
}

const ARC_PARSED = parseOrThrow(ARC_OUTPUT);

/** What the stages cost — the figures the ledger answers with on the real row. */
const STAGE_COST: Record<string, string> = {
  implement: "~2296k tokens · 1h 37m",
  audit: "~170k tokens · 6m 41s",
};

const COMPACT_RECAP =
  "## Compaction Summary\n\n" +
  "The session was landing the copy-paste-fidelity arc. The join is on `main` " +
  "as `133eae39b`; the audit's two findings were folded into the last round.\n\n" +
  "- Open: the `at0528` re-run against the new base";

const PROSE_BEFORE =
  "The audit is green and the arc has walked all ten rounds. Landing it whenever you are ready.";
const PROSE_AFTER =
  "Picking up on `main`: the arc's branch is released and the workshop is torn down.";

function exchange(command: string, output: string, id: string): CommandBlockProps {
  const message: ShellExchangeMessage = {
    kind: "shell_exchange",
    messageKey: id,
    createdAt: 0,
    exchangeId: id,
    command,
    output,
    exitCode: 0,
    cwd: ROOT,
    cwdAfter: ROOT,
    startedAtMs: 0,
    settledAtMs: 0,
  };
  return { message };
}

// ---------------------------------------------------------------------------
// The faux transcript column — real entries, the real inset arithmetic.
// ---------------------------------------------------------------------------

function Column({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={className !== undefined ? `sp-jr-column ${className}` : "sp-jr-column"}>
      {children}
    </div>
  );
}

/** A `$`-route entry, as `ShellTurnCell` mounts one: participant, identifier,
 *  the exec time paired with the cwd, and the `#s{n}` address. */
function Entry({
  participant,
  identifier,
  time,
  turn,
  body,
}: {
  participant: Participant;
  identifier: string;
  time: string;
  turn: number;
  body: React.ReactNode;
}): React.ReactElement {
  return (
    <TugTranscriptEntry
      participant={participant}
      identifier={identifier}
      timestamp={
        <>
          {time}
          {" • "}
          <span className="sp-jr-cwd">{ROOT}</span>
        </>
      }
      address={{ speaker: "shell", turn }}
      body={body}
    />
  );
}

/** Assistant prose in the body column, past the gutter. */
function Prose({ text }: { text: string }): React.ReactElement {
  return (
    <div className="sp-jr-body-seat">
      <TugMarkdownBlock initialText={text} className="sp-jr-prose" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zone 1 — TODAY. The three rows as they ship, real renderers.
// ---------------------------------------------------------------------------

function ZoneToday(): React.ReactElement {
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">Today — a record, an empty entry, and a second record</h2>
      <Column>
        <Prose text={PROSE_BEFORE} />
        <Entry
          participant="wheel"
          identifier="Wheel"
          time="8:50:34 AM"
          turn={2}
          body={<SessionArcReceiptBlock {...exchange("/arc-run", ARC_OUTPUT, "sp-jr-today-arc")} />}
        />
        <Entry
          participant="git"
          identifier="Git Commit"
          time="8:54:25 AM"
          turn={3}
          body={
            <SessionJoinReceiptBlock
              {...exchange(`/arc-join ${ARC}`, JOIN_OUTPUT, "sp-jr-today-join")}
            />
          }
        />
        <Prose text={PROSE_AFTER} />
      </Column>
      <p className="sp-jr-note">
        The Git Commit entry has nothing in it: its body is the boundary, which pulls
        to the edge. The commit's sha and subject sit on the boundary's bar, and its
        receipt folds behind them — while the arc's own record sits in a separate
        entry above, at a size borrowed from the timestamp beside "Git Commit".
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Zone 2 — THE CANDIDATE. Each thing where its kind lives.
// ---------------------------------------------------------------------------

/** The arc's record — what folds behind the Joined boundary. The Wheel
 *  receipt's body, at the tool header's detail size rather than the stamp's,
 *  led by the same lifecycle strip the Wheel header wore. */
function ArcRecord(): React.ReactElement {
  return (
    <div className="sp-jr-record" data-slot="sp-jr-record">
      <div className="sp-jr-record-strip">
        <ArcLifecycleBlock
          name={ARC}
          worker={null}
          model={trackModelFor(ARC_PARSED)}
          note={`Finished · ${ARC_PARSED.stages.length} stages`}
          layout="row"
        />
      </div>
      <p className="sp-jr-record-doc">
        opened on <code>{BRIEF}</code>
      </p>
      <ul className="sp-jr-record-stages">
        {ARC_PARSED.stages.map((stage) => (
          <li className="sp-jr-record-stage" key={stage.stage}>
            <span className="sp-jr-record-stage-word">{stage.stage}</span>
            <span className="sp-jr-record-stage-model">{stage.model}</span>
            <span className="sp-jr-record-stage-cost">{STAGE_COST[stage.stage] ?? ""}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The finish moment, as the quiet line every other arc gesture takes. */
function FinishLine(): React.ReactElement {
  return (
    <div className="sp-jr-body-seat sp-jr-quiet">
      <TugQuietLine
        icon={<ShipWheel size={16} aria-hidden="true" />}
        label={
          <span>
            <span className="sp-jr-arc-name">{ARC}</span> Finished
          </span>
        }
        subject={`${ARC_PARSED.stages.length} stages · audit passed`}
        tone="primary"
      />
    </div>
  );
}

/**
 * The Joined boundary. The compaction's anatomy, kept: rule, bar, glyph,
 * the bold event, badges, a chevron because something folds. What folds is
 * the arc's record. The bar carries no sha: the receipt above already names
 * the commit, and naming it twice is the doubling this spike exists to end.
 */
function JoinedBoundary({ id }: { id: string }): React.ReactElement {
  return (
    <SessionBoundary
      kind="join"
      className="tugx-commit-receipt sp-jr-boundary"
      glyph={<GitMerge size={16} aria-hidden="true" />}
      event={`Joined ${ARC} into main`}
      summary={[
        { kind: "count", count: ARC_PARSED.stages.length, noun: "stage" },
        { kind: "count", count: ROUNDS, noun: "round" },
      ]}
      fold={<ArcRecord />}
      collapseKey={id}
      copyText={ARC_OUTPUT}
    />
  );
}

function ZoneCandidate(): React.ReactElement {
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">Candidate — the commit in Git Commit, the arc behind Joined</h2>
      <Column className="sp-jr-proposed">
        <Prose text={PROSE_BEFORE} />
        <FinishLine />
        <Entry
          participant="git"
          identifier="Git Commit"
          time="8:54:25 AM"
          turn={3}
          body={
            <SessionCommitReceiptBlock
              {...exchange("/commit", COMMIT_OUTPUT, "sp-jr-candidate-commit")}
            />
          }
        />
        <JoinedBoundary id="sp-jr-candidate-joined" />
        <Prose text={PROSE_AFTER} />
        <SessionBoundary
          kind="compaction"
          glyph={<Layers size={16} aria-hidden="true" />}
          event="Session compacted"
          summary={{ kind: "text", text: "~142k tokens" }}
          fold={<TugMarkdownBlock initialText={COMPACT_RECAP} />}
          collapseKey="sp-jr-candidate-compaction"
          copyText={COMPACT_RECAP}
        />
      </Column>
      <p className="sp-jr-note">
        The Git Commit entry is exactly what a <code>/commit</code> on the main lane
        gets: the sha pill and the subject on the header, the file and ± badges, the
        message and the file list beneath, expanded. The Joined boundary is the
        compaction's shape with the arc's record folded behind it — the strip, the
        brief, the stages and what each cost. The Wheel's finish moment is a quiet
        line where it happened. Every subsidiary line reads at the tool header's
        detail size; only the entry's timestamp stays at the stamp size.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------

function SpikeJoinReport(): React.ReactElement {
  return (
    <div className="sp-content">
      <ZoneToday />
      <ZoneCandidate />
    </div>
  );
}

export const spike: SpikeDef = {
  name: "join-report",
  title: "Join Report",
  blurb:
    "Can the Wheel receipt, the Git Commit entry, and the Joined boundary read as one landing report?",
  icon: "GitMerge",
  size: {
    min: { width: 520, height: 420 },
    preferred: { width: 820, height: 760 },
  },
  component: () => <SpikeJoinReport />,
};
