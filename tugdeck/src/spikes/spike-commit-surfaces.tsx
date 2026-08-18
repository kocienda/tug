/**
 * spike-commit-surfaces.tsx — the one spike for every surface that shows a
 * commit, so each commit case has exactly one live demo:
 *
 *   1. The History shade's rows — the candidate built from
 *      `commit-presentation.tsx`: one `.tugx-commit` type scale, the shared
 *      identity line, a reader-chosen metadata cell (author / date / time),
 *      and a Copy control that writes the whole commit record.
 *   2. The `/commit` durable receipt in the transcript
 *      ({@link SessionCommitReceiptBlock}), parsing real S02 summaries — the
 *      wrapping-subject and single-line fixtures `at0264` measures.
 *   3. The `git commit` bash receipt ({@link CommitBlock}), driven through the
 *      real {@link parseGitCommit} over real command + stdout strings.
 *
 * Every fixture drives a production parse / render path over real repo
 * content, so what the card shows is what the app renders.
 *
 * @module components/tugways/cards/gallery-commit-surfaces
 */

import "./spike.css";
import type { SpikeDef } from "./spike-registry";
import "./spike-commit-surfaces.css";

import React, { useId, useState } from "react";

import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TugOptionGroup } from "@/components/tugways/tug-option-group";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { TugHistoryList } from "@/components/tugways/tug-history-list";
import {
  CommitBlock,
  CommitHeaderTarget,
  parseGitCommit,
  type CommitData,
} from "@/components/tugways/body-kinds/commit-block";
import { BlockChrome } from "@/components/tugways/blocks/block-chrome";
import { SessionCommitReceiptBlock } from "@/components/tugways/cards/session-commit-receipt-block";
import type { CommandBlockProps } from "@/components/tugways/cards/session-command-block-registry";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";
import type { GitLogCommit } from "@/lib/git-log-store";
import {
  commitCopyText,
  type CommitMetaField,
} from "@/components/tugways/commit-presentation";

// ---------------------------------------------------------------------------
// Fixtures — real commits from this repo
// ---------------------------------------------------------------------------

/** The dir the fixtures' shas belong to; the file lists resolve against it. */
const FIXTURE_ROOT = "/Users/dev/src/tugtool";

/**
 * The session trailers are TYPED FIELDS here, not body ink ([P10], Spec S03).
 * tugcast parses `Tug-Session:` / `Tug-Session-Id:` server-side and strips both
 * lines from the body before it ships, so a fixture that still spelled them in
 * `body` would be showing a shape the app can no longer receive — and the
 * gallery would be a lie about the surface it exists to show.
 *
 * The last entry deliberately keeps the **legacy one-line form**: a display
 * name rather than a callsign, a full uuid rather than a short id, and no
 * `tug_session_id` beside it. Legacy commits live in history forever, so the
 * bench needs one to render.
 */
const COMMITS: GitLogCommit[] = [
  {
    sha: "a14a3efc58f87ec7060122fab3c0843b47154e6a",
    subject:
      "tugdash(list-filtering): TugFilterField + fuzzy list filtering across picker, /resume, and Lens sections",
    tug_session: "stocky-pixie (248401c8)",
    tug_session_id: "248401c8-e9fd-4001-9a55-51ed3ff47c43",
    author: "Ken Kocienda",
    date: "2026-07-24",
    committer: "Ken Kocienda",
    committer_email: "kocienda@mac.com",
    committer_date: "2026-07-24T12:51:25-07:00",
  },
  {
    sha: "45a56a144fc9e6546e673a7da632f6564f8a674b",
    subject: "tugways(commit-receipt): promote commit sha into header identity slot",
    tug_session: "syrupy-beam (2fff7b8e)",
    tug_session_id: "2fff7b8e-41cf-489c-86a6-bc65d7eacf3a",
    author: "Ken Kocienda",
    date: "2026-07-24",
    committer: "Ken Kocienda",
    committer_email: "kocienda@mac.com",
    committer_date: "2026-07-24T12:39:15-07:00",
  },
  {
    sha: "5f3f8c49672cba6961086b89c3ab38051c05124c",
    subject: "tugways(progress-wave): keep tail-cell wave animating under offscreen-skip",
    body:
      "- reword tug-progress-wave.css comment to point at the content-visibility gap instead of restating layer-promotion rationale\n" +
      "- add `:last-child` opt-out in tug-list-view.css so the streaming tail cell stays content-visibility: visible and its wave keeps animating",
    tug_session: "petit-thaw-A1 (da17da2c)",
    tug_session_id: "da17da2c-635e-44da-9e02-75d5e67ada92",
    author: "Ken Kocienda",
    date: "2026-07-24",
    committer: "Ken Kocienda",
    committer_email: "kocienda@mac.com",
    committer_date: "2026-07-24T12:30:36-07:00",
  },
  {
    sha: "545eaefc6e8aba14c904cfca0a527675085d2042",
    subject: "tugways(transcript-git-row): attribute /commit rows to git, not shell",
    body:
      "- ghost-emphasize commit stat/hash badges in commit-block.tsx and session-commit-receipt-block.tsx (was outlined)\n" +
      '- add "git" participant (icon, color token, data-participant CSS) to tug-transcript-entry\n' +
      "- session-card-transcript.tsx: detect commit rows via exported matchesCommitReceipt",
    tug_session: "syrupy-beam (2fff7b8e)",
    tug_session_id: "2fff7b8e-41cf-489c-86a6-bc65d7eacf3a",
    author: "Ken Kocienda",
    date: "2026-07-24",
    committer: "Ken Kocienda",
    committer_email: "kocienda@mac.com",
    committer_date: "2026-07-24T11:35:12-07:00",
  },
  {
    sha: "e8595e04e7ded6b5b4c86772fef6779aab8f8bf5",
    subject:
      "tugways(progress-motion): promote indeterminate spinners/waves to compositor layers",
    body:
      "- swap `background-position-x` scroll for a `translateX`'d `::before` stripe layer on tug-progress-bar so WebKit compositors the scroll\n" +
      "- add scoped `will-change` (transform/opacity) to running/indeterminate states across gallery petals, session-changes spinner, tug-progress-pie/ring/spinner/pulsing-dot/wave",
    tug_session: "brisk-cairn (536ef459)",
    tug_session_id: "536ef459-cdbd-47ab-937a-43bce5d39eac",
    author: "Ken Kocienda",
    date: "2026-07-24",
    committer: "Ken Kocienda",
    committer_email: "kocienda@mac.com",
    committer_date: "2026-07-24T10:28:26-07:00",
  },
  {
    sha: "8ceec91d0f2a1a7f2ac4a1a8f6b7a45f0d3e21c9",
    subject: "roadmap(list-filtering): add TugFilterField plan for long-list fuzzy filtering",
    // THE LEGACY SPECIMEN — kept deliberately (Spec S03). One trailer, a
    // display name where a callsign now goes, and a full uuid where a short id
    // now goes. It still resolves, because the parenthesized token is a uuid
    // and that is an exact join.
    tug_session: "list-filtering (248401c8-e9fd-4001-9a55-51ed3ff47c43)",
    author: "Ken Kocienda",
    date: "2026-07-23",
    committer: "Ken Kocienda",
    committer_email: "kocienda@mac.com",
    committer_date: "2026-07-23T18:04:09-07:00",
  },
];

/** The copy payload for a fixture commit — header + everything expand reveals. */
function copyTextFor(commit: GitLogCommit): string {
  return commitCopyText({
    sha: commit.sha,
    subject: commit.subject,
    body: commit.body,
    author: commit.committer ?? commit.author,
    email: commit.committer_email,
    dateIso: commit.committer_date,
  });
}

// ---------------------------------------------------------------------------
// The `/commit` durable receipt (fixtures carried over from the retired tab)
// ---------------------------------------------------------------------------

/** A wrapping subject plus a body + trailer — the header must show only the
 *  subject. The shape that surfaced the header baseline + trailing-space bugs
 *  `at0264` measures. */
const OUTPUT_WRAPPING =
  `committed e5fe894037 · 2 file(s) · +58 −0\n` +
  `files: [{"path":"lincoln-generals.md","status":"created","added":25,"removed":0},` +
  `{"path":"lincoln-speeches.md","status":"created","added":33,"removed":0}]\n` +
  `docs(lincoln-generals): add commanding generals overview\n` +
  `\n` +
  `- add Lincoln's commanding generals hired/fired doc\n` +
  `- add list of Lincoln's 8 most famous speeches\n` +
  `\n` +
  `Tug-Session: Add five battles to civil war battles (1732aa42-a636-4643-99d3-43c781a4d16a)`;

/** A one-line subject — the header stays a single row. */
const OUTPUT_ONE_LINE =
  `committed 8245846f · 1 file(s) · +18 −3\n` +
  `files: [{"path":"smart-scroll.ts","status":"modified","added":18,"removed":3}]\n` +
  `Guard follow-bottom disengage on non-scrollable cards`;

function receiptProps(output: string, testid: string): CommandBlockProps {
  const message: ShellExchangeMessage = {
    kind: "shell_exchange",
    messageKey: testid,
    createdAt: 0,
    exchangeId: testid,
    command: "/commit",
    output,
    exitCode: 0,
    cwd: FIXTURE_ROOT,
    cwdAfter: FIXTURE_ROOT,
    startedAtMs: 0,
    settledAtMs: 0,
  };
  return { message };
}

// ---------------------------------------------------------------------------
// The `git commit` bash receipt (fixtures carried over from the retired tab)
// ---------------------------------------------------------------------------

const COMMIT_450_CMD =
  `git -C /Users/dev/src/tugtool add ` +
  `tugdeck/src/components/tugways/tug-text-editor/completion-extension.ts ` +
  `tugdeck/src/components/tugways/tug-text-editor/inline-command-completion.ts && ` +
  `git -C /Users/dev/src/tugtool commit -m "Add separating space when accepting a completion

- acceptCompletionAt: insert atom + space, caret past the space
- acceptInlineGhost: insert command suffix + space, caret past it
- Skip the space when one already follows, to avoid a double space"`;

const COMMIT_450_OUT = `[main 450d6b28] Add separating space when accepting a completion
 2 files changed, 32 insertions(+), 14 deletions(-)`;

const COMMIT_TERSE_CMD = `git commit -m "Bump tugcode to 2.1.181"`;
const COMMIT_TERSE_OUT = `[release 9a0b1c2d] Bump tugcode to 2.1.181
 1 file changed, 1 insertion(+), 1 deletion(-)`;

/** The enriched form: `git commit … && git show --numstat` — the numstat lines
 *  drive the counts, the mode lines upgrade status to A / D. */
const COMMIT_ENRICHED_CMD =
  `git commit -m "Add commit receipt body kind

- New CommitBlock + parser
- Gallery fixture across states" && git --no-pager show --numstat --format= HEAD`;

const COMMIT_ENRICHED_OUT = `[main 1f2e3d4c] Add commit receipt body kind
 4 files changed, 514 insertions(+), 23 deletions(-)
 create mode 100644 tugdeck/src/components/tugways/body-kinds/commit-block.tsx
 create mode 100644 tugdeck/src/components/tugways/body-kinds/commit-block.css
 delete mode 100644 tugdeck/src/lib/old-commit-helper.ts

312\t0\ttugdeck/src/components/tugways/body-kinds/commit-block.tsx
196\t0\ttugdeck/src/components/tugways/body-kinds/commit-block.css
6\t1\ttugdeck/src/components/tugways/cards/session-assistant-renderer-dispatch.ts
0\t22\ttugdeck/src/lib/old-commit-helper.ts`;

function parseOrThrow(command: string, stdout: string): CommitData {
  const data = parseGitCommit(command, stdout);
  if (data === null) {
    throw new Error("gallery-commit-surfaces: fixture failed to parse");
  }
  return data;
}

const COMMIT_450 = parseOrThrow(COMMIT_450_CMD, COMMIT_450_OUT);
const COMMIT_TERSE = parseOrThrow(COMMIT_TERSE_CMD, COMMIT_TERSE_OUT);
const COMMIT_ENRICHED = parseOrThrow(COMMIT_ENRICHED_CMD, COMMIT_ENRICHED_OUT);

/** Mount a bash receipt the way `BashToolBlock` does — real chrome, real body. */
function BashCommitReceipt({ commit }: { commit: CommitData }): React.ReactElement {
  return (
    <BlockChrome
      toolName="Git Commit"
      status="ready"
      phase="success"
      rootSlot="commit-tool-block"
      identity={<CommitHeaderTarget commit={commit} />}
      copyText={`${commit.hash} ${commit.summary}`}
    >
      <CommitBlock commit={commit} />
    </BlockChrome>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function Caption({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="gallery-commit-surfaces-caption">{children}</div>;
}

const META_ITEMS = [
  { value: "author", label: "Author" },
  { value: "date", label: "Date" },
  { value: "time", label: "Time" },
];

export function SpikeCommitSurfaces(): React.ReactElement {
  // Which metadata the rows carry. Readers disagree about this — some want the
  // author, some the date, some the clock — so it is a choice, not a default
  // baked into the row. `TugOptionGroup` is a multi-toggle: zero or more on.
  const [metaFields, setMetaFields] = useState<string[]>(["date", "time"]);
  const metaId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    setValueStringArray: { [metaId]: setMetaFields },
  });
  const fields = metaFields as CommitMetaField[];

  return (
    <ResponderScope>
      <div
        className="gallery-commit-surfaces"
        data-testid="gallery-commit-surfaces"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <TugLabel size="lg">History rows</TugLabel>
        <Caption>
          The subject sits at the compact mono row's own size; wrapped lines take a slightly
          tighter leading than the first, so a two-line commit reads as one entry while the gap
          between entries stays what it is today. The trailing metadata is the reader's call —
          toggle author / date / time below. Copy writes the whole commit record; right-clicking
          the sha copies <code>Commit a14a3efc</code>.
        </Caption>
        <div className="gallery-commit-surfaces-panel">
          <TugHistoryList
            commits={COMMITS}
            projectDir={FIXTURE_ROOT}
            metaFields={fields}
          />
        </div>
        <div className="gallery-commit-surfaces-options">
          <TugOptionGroup
            value={metaFields}
            senderId={metaId}
            size="xs"
            aria-label="Commit row metadata"
            data-testid="commit-meta-options"
            items={META_ITEMS}
          />
        </div>

        <TugSeparator />

        <TugLabel size="lg">What Copy writes</TugLabel>
        <Caption>
          <code>commitCopyText()</code> — the collapsed header plus everything expanding reveals,
          whatever the row's current fold state, including the complete hash.
        </Caption>
        <pre className="gallery-commit-surfaces-copy">{copyTextFor(COMMITS[2])}</pre>

        <TugSeparator />

        <TugLabel size="lg">
          <code>/commit</code> durable receipt — wrapping subject
        </TugLabel>
        <Caption>
          Baseline against the “Commit” name and the header's bottom padding (measured by
          <code> at0264</code>). The header shows only the subject; the body and trailer live in
          the copied text.
        </Caption>
        <div className="sp-section" data-testid="commit-receipt-wrapping">
          <SessionCommitReceiptBlock {...receiptProps(OUTPUT_WRAPPING, "wrapping")} />
        </div>

        <TugSeparator />

        <TugLabel size="lg">
          <code>/commit</code> durable receipt — single-line subject
        </TugLabel>
        <div className="sp-section" data-testid="commit-receipt-one-line">
          <SessionCommitReceiptBlock {...receiptProps(OUTPUT_ONE_LINE, "one-line")} />
        </div>

        <TugSeparator />

        <TugLabel size="lg">
          <code>git commit</code> bash receipt
        </TugLabel>
        <Caption>
          The <code>BashToolBlock</code> routing target, driven through the real
          <code> parseGitCommit</code>: a multi-file commit, a one-line message with no body
          disclosure, and the enriched <code>--numstat</code> form with its per-file breakdown.
        </Caption>
        <div className="gallery-commit-surfaces-stack">
          <BashCommitReceipt commit={COMMIT_450} />
          <BashCommitReceipt commit={COMMIT_TERSE} />
          <BashCommitReceipt commit={COMMIT_ENRICHED} />
        </div>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "commit-surfaces",
  title: "Commit Surfaces",
  blurb: "Every surface that shows a commit, side by side: History rows, the durable receipt, and the shared identity line.",
  component: () => <SpikeCommitSurfaces />,
};
