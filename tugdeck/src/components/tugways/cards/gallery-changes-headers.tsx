/**
 * gallery-changes-headers.tsx — the Changes shade's section vocabulary, whole,
 * in one place.
 *
 * This began as two design spikes and is now the reference for what they
 * settled. Both questions are closed and neither is re-litigated here:
 *
 *   **The header is the eyebrow, and it is quiet.** A small tracked-out label
 *   at the left, the hairline running through the rest of the line, the bucket
 *   name ahead of a dimmer qualifier — and no hue on any of it. Colour in this
 *   surface would have to mean something, and the four things it could have
 *   meant (ownership, urgency, species, staleness) are all said in words a
 *   line below.
 *
 *   **A dash wears its caret and no box.** `DashSigil` — the same component a
 *   bound session's identity atom composes — so a dash named in the lane and
 *   the same dash named in a session's title are one rendering rather than two
 *   that agree by hand. The tinted chip it replaced said "tag" where the caret
 *   says "dash", and it was the loudest thing in a row whose news is the facts
 *   beside it.
 *
 * What the card is FOR now that both are adopted: seeing all six section
 * headers and every dash-row shape at once — long names, short names, review
 * tints, a damaged ledger, a lane with nothing fronted — without arranging a
 * repository that produces them. The real shade shows you two of these on a
 * good day.
 *
 * **Everything here is the shipping thing.** `TugChangesList`,
 * `SessionChangesDashLane` and `DashSigil` are the components; the header
 * strings come from `changes-section-labels.ts`, the module the shade reads;
 * the styling is `tug-changes-list.css` and `session-changes-dash-lane.css`
 * with nothing overridden. This file contributes fixture data and a frame to
 * put it in. There is deliberately no variant switch left: a card that can
 * render a treatment which does not ship is a card that can lie about what
 * ships.
 *
 * The lane is read-only: no `landing`, `binding`, or `discard` props, so no
 * row offers a verb and nothing here can reach a repository.
 *
 * @module components/tugways/cards/gallery-changes-headers
 */

import "./gallery-changes-headers.css";

import React from "react";

import { TugLabel } from "@/components/tugways/tug-label";
import { BlockStrip } from "@/components/tugways/blocks/block-strip";
import { GitCommitHorizontal } from "lucide-react";
import {
  TugChangesList,
  type TugChangesListEntry,
} from "@/components/tugways/tug-changes-list";
import { SessionChangesDashLane } from "./session-changes/session-changes-dash-lane";
import {
  ORPHANED_LABEL,
  SESSION_LABEL,
  UNATTRIBUTED_DEGRADED_LABEL,
  UNATTRIBUTED_LABEL,
} from "./session-changes/changes-section-labels";
import type {
  ChangesetFile,
  DashChangesetEntry,
  ProjectChangeset,
} from "@/lib/changeset-types";

// ---------------------------------------------------------------------------
// Fixture data — real shapes, plausible content
// ---------------------------------------------------------------------------

const ROOT = "/Users/kocienda/Mounts/u/src/tugtool";
const OWNER = "at-gallery-session";
const TOUCHED = 1_760_000_000_000;

function file(
  path: string,
  git_status: string,
  op: string,
  origin: string,
  shared = false,
): ChangesetFile {
  return { path, git_status, op, origin, shared, last_touched: TOUCHED };
}

const PROJECT: ProjectChangeset = {
  workspace_key: ROOT,
  project_dir: ROOT,
  display_name: "tugtool",
  no_repo: false,
  branch: "main",
  ahead: 0,
  behind: 0,
  head_sha: "22e07a9ef",
  head_message: "tugdash(dash-vocab): the caret replaces the lozenge",
  changesets: [],
  unattributed: [],
};

/** The three head buckets, in the order the shade stacks them. */
const HEAD_ENTRIES: TugChangesListEntry[] = [
  {
    kind: "session",
    id: "gallery:session",
    project: PROJECT,
    entry: {
      kind: "session",
      owner_id: OWNER,
      display_name: "Changes shade chrome",
      live: true,
      files: [
        file(
          "tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx",
          " M",
          "edit",
          "exact",
        ),
        file("tugdeck/src/components/tugways/tug-prompt-entry.tsx", " M", "edit", "exact"),
        file(
          "tugdeck/src/components/tugways/cards/session-changes/changes-section-labels.ts",
          "??",
          "write",
          "exact",
        ),
      ],
    },
  },
  {
    kind: "unattributed",
    id: "gallery:unattributed",
    project: PROJECT,
    files: [
      { path: "roadmap/assets/dash-notes.md", git_status: " M" },
      { path: "tuglaws/theme-engine.md", git_status: " M", hinted_by: ["Lens redesign"] },
    ],
  },
  {
    kind: "orphaned",
    id: "gallery:orphaned",
    project: PROJECT,
    files: [
      {
        path: "tugrust/crates/tugdash-core/src/ops.rs",
        git_status: " M",
        op: "edit",
        origin: "exact",
        prior_owner_name: "Dash log parser",
        prior_owner_id: "at-gallery-dead",
        last_touched: TOUCHED,
      },
    ],
  },
];

/** The unattributed bucket alone, wearing its ledger-damaged spelling. */
const DEGRADED_ENTRIES: TugChangesListEntry[] = [HEAD_ENTRIES[1]];

function dash(
  display_name: string,
  over: Partial<DashChangesetEntry> = {},
): DashChangesetEntry {
  return {
    kind: "dash",
    owner_id: `tugdash/${display_name}#gallery-${display_name}`,
    display_name,
    branch: `tugdash/${display_name}`,
    base: "main",
    rounds: 3,
    worktree: `${ROOT}/.tug/worktrees/${display_name}`,
    worktree_dirty: false,
    files: [file("tugdeck/src/components/lens/sections/dash-facts.tsx", "M", "edit", "dash")],
    stage: "working",
    ...over,
  };
}

const FRONTED = dash("changes-headers", {
  bound_sessions: [OWNER],
  stage: "implementing",
  step_current: 2,
  step_total: 5,
  step_title: "The header treatments, side by side",
  plan_path: "roadmap/changes-headers.md",
  rounds: 4,
});

/**
 * The rest, chosen so the set covers every shape a dash name can take: a very
 * short one, a long one that has to ellipsize, and both review states that
 * tint the run. The real lane shows one or two of these at a time.
 */
const OTHERS: DashChangesetEntry[] = [
  dash("fix", { rounds: 1, stage: "created", review: "never-reviewed" }),
  dash("premerge-claim", {
    rounds: 7,
    stage: "draft-ready",
    worktree_dirty: true,
  }),
  dash("transcript-dom-eviction-placeholders", {
    rounds: 12,
    stage: "audited",
    review: "stale",
  }),
];

const EMPTY_KEYS: ReadonlySet<string> = new Set();
const NOOP_TOGGLE = (): void => {};

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/** One captioned stage — a slice of the shade, and what it is here to show. */
function Stage({
  caption,
  children,
}: {
  caption: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="gallery-changes-headers-section">
      <TugLabel size="2xs" emphasis="calm" className="gallery-changes-headers-caption">
        {caption}
      </TugLabel>
      <div className="gallery-changes-headers-stage">{children}</div>
    </section>
  );
}

export function GalleryChangesHeaders(): React.ReactElement {
  return (
    <div className="gallery-changes-headers" data-testid="gallery-changes-headers">
      <Stage caption="The shade as it stacks — four headers, and the dash rows under the last two">
        {/* The shade's own header, for the tier above the sections. It is card
            chrome, and it is here so a section header is read against the
            thing it sits beneath. */}
        <BlockStrip
          altitude="section"
          className="tool-call-header"
          leading={
            <span className="tool-call-header-leading" aria-hidden="true">
              <GitCommitHorizontal size={14} />
            </span>
          }
          name="Changes"
        />
        <TugChangesList
          entries={HEAD_ENTRIES}
          ownSessionId={OWNER}
          expandedKeys={EMPTY_KEYS}
          onToggleFile={NOOP_TOGGLE}
          sessionLabel={SESSION_LABEL}
          unattributedLabel={UNATTRIBUTED_LABEL}
          orphanedLabel={ORPHANED_LABEL}
        />
        <SessionChangesDashLane
          dashes={[FRONTED, ...OTHERS]}
          boundDashId={FRONTED.owner_id}
          frontedDashId={FRONTED.owner_id}
          projectRoot={ROOT}
        />
      </Stage>

      <Stage caption="The two the stack above cannot show at the same time as the ones it does">
        <TugChangesList
          entries={DEGRADED_ENTRIES}
          ownSessionId={OWNER}
          expandedKeys={EMPTY_KEYS}
          onToggleFile={NOOP_TOGGLE}
          unattributedLabel={UNATTRIBUTED_DEGRADED_LABEL}
        />
        <SessionChangesDashLane
          dashes={OTHERS}
          boundDashId={null}
          frontedDashId={null}
          projectRoot={ROOT}
        />
      </Stage>
    </div>
  );
}
