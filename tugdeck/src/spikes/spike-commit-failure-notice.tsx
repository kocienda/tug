/**
 * spike-commit-failure-notice.tsx — where does a refused commit speak?
 *
 * What ships today: a `changeset_commit_err` settles into `landError`, and
 * `LandingNoticeController` posts a sticky danger bulletin titled "Commit
 * failed" to the card's OUTER `TugPaneBulletinProvider` — the top-right corner
 * lane. Three things are wrong with that at once, and the first stage below
 * reproduces all three with the real bulletin component:
 *
 *   1. **It is behind the scrim.** The Changes shade raises the pane scrim
 *      over the transcript, and the bulletin toaster is stacked inside the
 *      provider's own isolated root, so the scrim covers it. The one thing the
 *      user needs to read arrives dimmed.
 *   2. **It is at the wrong end of the card.** The press happened at Z5, the
 *      bottom-right of the composer. The answer appears top-right, the
 *      farthest point on the card from the button, over a transcript that has
 *      nothing to do with the commit.
 *   3. **It says what git said, and offers OK.** The title names the verb,
 *      the body is raw stderr, and the only action is to make it go away.
 *      Nothing on it retries, nothing on it copies, and nothing translates
 *      "index.lock: File exists" into a sentence about what to do.
 *
 * The premise the candidates share: a commit failure has a *grain*. The
 * modal-rest-line doctrine already exempts the Changes shade from the rest
 * line because the shade and the message editor below it "are one gesture"
 * ([D117]). A refusal of that gesture belongs on the gesture — between the
 * files being committed and the message they are being committed under, in
 * the region the scrim never covers, next to the button that was pressed.
 * The corner lane stays for notices that have no card grain to obey, which
 * is what the doctrine already says it is for.
 *
 * Three candidates take that premise to three seats:
 *
 *   A. **The seam.** A `TugInlineAlert` (danger) between the shade's bottom
 *      edge and the composer's top edge. Title is the plain cause, message is
 *      what to do, git's own words fold behind a disclosure, and the actions
 *      are Retry and Copy details. It stands until the next press or the
 *      mode's exit, and a second failure replaces it in place.
 *   B. **The composer's status row.** The row the entry already has above the
 *      input, wearing the danger tone: one sentence, one "why" disclosure,
 *      and the Commit button's tooltip becomes "Retry". Smallest footprint;
 *      the least room for the remediation.
 *   C. **The shade's foot.** The same inline alert, but inside the shade's
 *      document, below the file rows. Closest to the files; farthest from the
 *      button; and it scrolls with the list.
 *
 * The recommendation is A, for the reasons the last section states.
 *
 * @module spikes/spike-commit-failure-notice
 */

import "./spike.css";
import type { SpikeDef } from "./spike-registry";
import "./spike-commit-failure-notice.css";

import React, { useId, useLayoutEffect, useState } from "react";
import {
  ArrowUp,
  ChevronsDownUp,
  ExternalLink,
  GitCommitHorizontal,
  X,
} from "lucide-react";

import { PencilSparkles } from "@/components/tugways/tug-icons";
import { TugInlineAlert } from "@/components/tugways/tug-inline-alert";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import {
  TugPaneBulletinProvider,
  useTugPaneBulletin,
} from "@/components/tugways/tug-pane-bulletin";
import {
  TugOptionGroup,
  type TugOptionItem,
} from "@/components/tugways/tug-option-group";
import { useResponderForm } from "@/components/tugways/use-responder-form";

// ---------------------------------------------------------------------------
// Fixture — the failure in the screenshot, verbatim
// ---------------------------------------------------------------------------

/** What tugcast relayed as `detail`: git's stderr, unedited. */
const GIT_STDERR =
  "fatal: Unable to create '/u/src/tug/.git/index.lock': File exists.\n" +
  "\n" +
  "Another git process seems to be running in this repository, e.g.\n" +
  "an editor opened by 'git commit'. Please make sure all processes\n" +
  "are terminated then try again. If it still fails, a git process\n" +
  "may have crashed in this repository earlier:\n" +
  "remove the file manually to continue.";

/**
 * The sentence Tug says instead. Title names the cause in the user's frame;
 * message names the remediation. Git's words are kept, folded, and copyable —
 * the translation adds a layer, it does not replace the evidence.
 */
const CAUSE_TITLE = "Another git process is holding the repository lock";
const CAUSE_MESSAGE =
  "Tug couldn't take .git/index.lock. If nothing else is running git here, " +
  "remove the lock file and try again — your message is kept.";

const COMMIT_SUBJECT =
  "notes(receipt-typography-brief): Brief prose face, full-width wrap, and a segment-keyed usage cell for receipts";
const COMMIT_BODY = [
  "Drops the claude session id from receipt ink and reads token/active-time usage off the ledger by the same segment id instead",
  "Fixes the shared `.tugx-commit` scope forcing mono type and a `ch`-measured hang onto proportional receipt prose",
  "Retires the 90-day session-row age sweep, since it protects a rounding error and answers no argument for any finite number",
];

const FILES = [
  { path: "notes/ink-follows-the-file-brief.md", origin: "claimed", added: 84 },
  { path: "notes/receipt-typography-brief.md", origin: "created · cmd", added: 185 },
];

// ---------------------------------------------------------------------------
// Stage furniture — the card's bottom region, mocked just far enough to place
// a notice against. The notice components are the real ones.
// ---------------------------------------------------------------------------

/** A few dimmed transcript lines so the scrim has something to cover. */
function TranscriptFill(): React.ReactElement {
  return (
    <div className="sp-cfn-transcript" aria-hidden="true">
      <p>
        Forever. The brief now decides it ([B13]) and there are no open
        questions left.
      </p>
      <p>I went and measured what the 90 days was protecting, and the answer is nothing:</p>
      <ul>
        <li>
          <b>What the sweep removes is a rounding error.</b> <code>sessions</code>{" "}
          has 261 rows and <code>turn_telemetry</code> 727 after six months.
        </li>
        <li>
          <b>What has size, the sweep never touched.</b> The ledger is 198 MB;{" "}
          <code>facts</code> is 120 MB plus 35 MB of indexes.
        </li>
      </ul>
    </div>
  );
}

/** The Changes shade: header, section label, two rows, the disclaim foot. */
function ShadeMock({ foot }: { foot?: React.ReactNode }): React.ReactElement {
  return (
    <div className="sp-cfn-shade">
      <div className="sp-cfn-shade-header">
        <GitCommitHorizontal size={14} strokeWidth={2} />
        <span className="sp-cfn-shade-title">Changes</span>
        <span className="sp-cfn-shade-tools">
          <TugIconButton icon={<ChevronsDownUp size={14} />} aria-label="Fold all" />
          <TugIconButton icon={<ExternalLink size={14} />} aria-label="Pop out diff" />
          <TugIconButton icon={<X size={14} />} aria-label="Close" />
        </span>
      </div>
      <div className="sp-cfn-shade-body">
        <div className="sp-cfn-section-label">Changes in this session</div>
        {FILES.map((f) => (
          <div className="sp-cfn-row" key={f.path}>
            <span className="sp-cfn-row-status">N</span>
            <span className="sp-cfn-row-path">{f.path}</span>
            <span className="sp-cfn-row-origin">{f.origin}</span>
            <span className="sp-cfn-row-count">+{f.added} −0</span>
          </div>
        ))}
        <div className="sp-cfn-shade-foot">
          <TugPushButton emphasis="outlined" role="accent" size="xs">
            Disclaim all
          </TugPushButton>
        </div>
        {foot}
      </div>
    </div>
  );
}

/** The composer in commit mode: the message, the mode footer, and Z5. */
function ComposerMock({
  statusRow,
  landLabel = "Commit",
}: {
  statusRow?: React.ReactNode;
  landLabel?: string;
}): React.ReactElement {
  return (
    <div className="sp-cfn-composer">
      {statusRow}
      <div className="sp-cfn-editor">
        <div className="sp-cfn-editor-subject">{COMMIT_SUBJECT}</div>
        {COMMIT_BODY.map((line) => (
          <div className="sp-cfn-editor-line" key={line}>
            - {line}
          </div>
        ))}
      </div>
      <div className="sp-cfn-composer-footer">
        <span className="sp-cfn-route">
          <span>Prompt</span>
          <span data-active="">Changes</span>
        </span>
        <span className="sp-cfn-chips">
          <span className="sp-cfn-chip">
            <small>project</small>tug
          </span>
          <span className="sp-cfn-chip">
            <small>changes</small>2 files
          </span>
        </span>
        <span className="sp-cfn-z5">
          <TugPushButton
            subtype="icon"
            size="lg"
            emphasis="outlined"
            role="accent"
            aria-label="Auto-message"
            icon={<PencilSparkles size={16} strokeWidth={2} />}
          />
          <TugPushButton
            subtype="icon"
            size="lg"
            emphasis="filled"
            role="accent"
            aria-label={landLabel}
            title={landLabel}
            icon={<ArrowUp size={16} strokeWidth={2.5} />}
          />
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage 0 — what ships. The REAL bulletin, under a scrim, at the top.
// ---------------------------------------------------------------------------

/** Posts the shipped notice into the stage's provider, exactly as the app does. */
function ShippedNoticePoster(): null {
  const api = useTugPaneBulletin();
  useLayoutEffect(() => {
    api.danger("Commit failed", {
      id: "commit-error",
      description: GIT_STDERR,
      sticky: true,
    });
    return () => api.dismiss("commit-error");
  }, [api]);
  return null;
}

function StageShipped(): React.ReactElement {
  return (
    <TugPaneBulletinProvider placement="top-right" className="sp-cfn-stage">
      <ShippedNoticePoster />
      <TranscriptFill />
      {/* The scrim is a sibling of the toaster with the higher z, which is the
          real geometry: the pane's scrim layer covers the bulletin root. */}
      <div className="sp-cfn-scrim" aria-hidden="true" />
      <div className="sp-cfn-bottom">
        <ShadeMock />
        <ComposerMock />
      </div>
    </TugPaneBulletinProvider>
  );
}

// ---------------------------------------------------------------------------
// The notice itself — one component, three seats
// ---------------------------------------------------------------------------

/** The notice A and C share: plain cause, remediation, folded evidence, two acts. */
function FailureNotice({ compact = false }: { compact?: boolean }): React.ReactElement {
  const [showGit, setShowGit] = useState(false);
  return (
    <div className="sp-cfn-notice" data-compact={compact ? "" : undefined}>
      <TugInlineAlert
        tone="danger"
        live="alert"
        icon="TriangleAlert"
        title={CAUSE_TITLE}
        message={
          <>
            {CAUSE_MESSAGE}{" "}
            <button
              type="button"
              className="sp-cfn-disclose"
              aria-expanded={showGit}
              onClick={() => setShowGit((v) => !v)}
            >
              {showGit ? "Hide git's message" : "Show git's message"}
            </button>
            {showGit ? <pre className="sp-cfn-stderr">{GIT_STDERR}</pre> : null}
          </>
        }
        actions={
          <>
            <TugPushButton emphasis="outlined" role="accent" size="sm">
              Copy details
            </TugPushButton>
            <TugPushButton emphasis="filled" role="danger" size="sm">
              Retry commit
            </TugPushButton>
          </>
        }
      />
      <span className="sp-cfn-notice-close">
        <TugIconButton icon={<X size={14} />} aria-label="Dismiss" />
      </span>
    </div>
  );
}

/** Candidate A — the seam between the shade and the composer. */
function StageSeam(): React.ReactElement {
  return (
    <div className="sp-cfn-stage">
      <TranscriptFill />
      <div className="sp-cfn-scrim" aria-hidden="true" />
      <div className="sp-cfn-bottom">
        <ShadeMock />
        <FailureNotice />
        <ComposerMock landLabel="Retry commit" />
      </div>
    </div>
  );
}

/** Candidate B — the composer's own status row, one line, danger tone. */
function StageStatusRow(): React.ReactElement {
  const [showGit, setShowGit] = useState(false);
  return (
    <div className="sp-cfn-stage">
      <TranscriptFill />
      <div className="sp-cfn-scrim" aria-hidden="true" />
      <div className="sp-cfn-bottom">
        <ShadeMock />
        <ComposerMock
          landLabel="Retry commit"
          statusRow={
            <div className="sp-cfn-status" role="alert">
              <span className="sp-cfn-status-text">
                <b>Commit refused.</b> {CAUSE_TITLE} — remove{" "}
                <code>.git/index.lock</code> and press Commit again.
              </span>
              <button
                type="button"
                className="sp-cfn-disclose"
                aria-expanded={showGit}
                onClick={() => setShowGit((v) => !v)}
              >
                {showGit ? "Hide why" : "Why?"}
              </button>
              {showGit ? <pre className="sp-cfn-stderr">{GIT_STDERR}</pre> : null}
            </div>
          }
        />
      </div>
    </div>
  );
}

/** Candidate C — inside the shade, under the file rows. */
function StageShadeFoot(): React.ReactElement {
  return (
    <div className="sp-cfn-stage">
      <TranscriptFill />
      <div className="sp-cfn-scrim" aria-hidden="true" />
      <div className="sp-cfn-bottom">
        <ShadeMock foot={<FailureNotice compact />} />
        <ComposerMock landLabel="Retry commit" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The spike
// ---------------------------------------------------------------------------

type Candidate = "shipped" | "seam" | "status" | "foot";

const CANDIDATE_ITEMS: TugOptionItem[] = [
  { value: "shipped", label: "What ships" },
  { value: "seam", label: "A · Seam" },
  { value: "status", label: "B · Status row" },
  { value: "foot", label: "C · Shade foot" },
];

function SpikeCommitFailureNotice(): React.ReactElement {
  const [candidate, setCandidate] = useState<Candidate>("shipped");
  // `TugOptionGroup` is a multi-toggle driven through the responder chain
  // ([L11]); the form hook hands its `setValue` here. Single-select is the
  // newest item on, so a press always lands, and a press on the lit item
  // (which the group reports as an empty set) keeps what was showing.
  const pickerId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    setValueStringArray: {
      [pickerId]: (next: string[]) => {
        const pressed = next.find((v) => v !== candidate);
        if (pressed !== undefined) setCandidate(pressed as Candidate);
      },
    },
  });
  return (
    <ResponderScope>
    <div
      className="sp-content sp-cfn"
      ref={responderRef as (el: HTMLDivElement | null) => void}
    >
      <section className="sp-section">
        <h2 className="sp-section-title">The stage</h2>
        <p className="sp-cfn-caption">
          The bottom of a Session card in commit mode: Changes shade up, scrim
          over the transcript, message written, Commit pressed — and git refused
          because <code>.git/index.lock</code> already exists. Pick where the
          refusal speaks.
        </p>
        <TugOptionGroup
          value={[candidate]}
          senderId={pickerId}
          size="xs"
          items={CANDIDATE_ITEMS}
          aria-label="Candidate"
        />
        {candidate === "shipped" ? <StageShipped /> : null}
        {candidate === "seam" ? <StageSeam /> : null}
        {candidate === "status" ? <StageStatusRow /> : null}
        {candidate === "foot" ? <StageShadeFoot /> : null}
        <p className="sp-cfn-caption">
          {candidate === "shipped" ? (
            <>
              <b>What ships.</b> The real <code>TugPaneBulletinProvider</code>{" "}
              posting the real sticky danger bulletin the{" "}
              <code>LandingNoticeController</code> posts, in the top-right lane.
              The stage's scrim is a sibling above the toaster, which is the
              app's geometry too — so the notice is dimmed, it is as far from
              Z5 as the card allows, and its only act is OK.
            </>
          ) : null}
          {candidate === "seam" ? (
            <>
              <b>A · The seam.</b> Between the files and the message, in the
              region the scrim never covers, one gutter above the button that
              was pressed. Title is the cause, message is the remedy, git's
              words fold, and the acts are Retry and Copy. The Commit button's
              own label becomes Retry for as long as the notice stands.
            </>
          ) : null}
          {candidate === "status" ? (
            <>
              <b>B · The status row.</b> The row the composer already owns above
              its input, wearing danger. One sentence and a "Why?" — the
              smallest footprint, right over the editor, but no room for a
              second act, and the remedy has to fit on one line.
            </>
          ) : null}
          {candidate === "foot" ? (
            <>
              <b>C · The shade's foot.</b> Inside the shade's own document,
              under the rows it failed to commit. Closest to the evidence,
              farthest from the button, and it scrolls away with a long file
              list — the notice belongs to the gesture, not to the list.
            </>
          ) : null}
        </p>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">The sentence</h2>
        <p className="sp-cfn-caption">
          Whatever seat wins, the bulletin's words were wrong too. "Commit
          failed" names the verb the user just pressed; they know. The title
          should name the <em>cause</em> in the user's frame, the message the{" "}
          <em>remedy</em>, and git's own stderr should be kept — folded and
          copyable — because it is the evidence. A small table of the refusals
          git actually produces covers nearly all of them; anything unmatched
          falls back to git's first line as the title.
        </p>
        <table className="sp-cfn-table">
          <thead>
            <tr>
              <th>git says</th>
              <th>Title</th>
              <th>Remedy</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>Unable to create '…/index.lock': File exists</code>
              </td>
              <td>Another git process is holding the repository lock</td>
              <td>If nothing else is running git here, remove the lock file and try again.</td>
            </tr>
            <tr>
              <td>
                <code>Please tell me who you are</code>
              </td>
              <td>Git doesn't know who you are yet</td>
              <td>Set your name and email in Configure Tug, then try again.</td>
            </tr>
            <tr>
              <td>
                <code>pre-commit hook failed</code> / exit 1 with hook output
              </td>
              <td>A commit hook refused the commit</td>
              <td>Read the hook's output below, fix what it names, and try again.</td>
            </tr>
            <tr>
              <td>
                <code>nothing to commit, working tree clean</code>
              </td>
              <td>Nothing left to commit</td>
              <td>The files were already committed — likely by another session.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Recommendation</h2>
        <div className="sp-cfn-caption sp-cfn-verdict">
          <p>
            <b>A, the seam.</b> The doctrine already says the shade and the
            message editor are one gesture; a refusal of that gesture is part
            of it, and the seam is the one place that is inside the gesture,
            outside the scrim by construction rather than by z-index, and one
            gutter from the button. B is the fallback when the seam is too
            costly to add — it is a slot the composer already renders — but
            it cannot hold a remedy and a second act. C ties the notice to the
            list, and the list is not what failed.
          </p>
          <p>
            <b>Lifetime.</b> The notice stands until the next land press or
            the mode's exit; a second failure replaces it in place (the same
            stable id the bulletin uses today). It never auto-dismisses — the
            user must read it — and it never blocks: the editor keeps focus,
            the message is kept, Retry is Return.
          </p>
          <p>
            <b>The lane rule this settles.</b> A landing failure has a card
            grain — the commit surface — so it does not go to the corner lane.
            The corner lane keeps what the modal-rest-line doc already gives
            it: notices with no grain to obey. <code>landingNoticeDecision</code>{" "}
            stays the one place that decides <em>what</em> to say; only the
            surface it is projected onto moves. The join landing gets the same
            seat for free, since the controller is already generic over the
            mode.
          </p>
        </div>
      </section>
    </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "commit-failure-notice",
  title: "Commit Failure Notice",
  blurb:
    "Where does a refused commit speak — the corner toast under the shade's scrim, or the seam between the files and the message it addresses?",
  icon: "TriangleAlert",
  size: {
    min: { width: 480, height: 420 },
    preferred: { width: 760, height: 900 },
  },
  component: () => <SpikeCommitFailureNotice />,
};
