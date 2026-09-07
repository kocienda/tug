/**
 * The fronted arc's documents, as rows you can open.
 *
 * An arc's brief and its plan were readable because they were files in the
 * tree; they still are files, just not tracked ones, and the card must not make
 * them harder to reach for it. Each row opens its document in a Text card
 * through the one path every open in the deck takes, so hand-editing a brief is
 * the same gesture it always was — and reading one is a click rather than a
 * shell.
 *
 * The row's title is read on the **server**: the card has no filesystem, so a
 * surface that wants to name a document cannot open it to find out. Absent, the
 * role stands in — a document with no heading is still a document.
 *
 * The section mounts its own eyebrow, as the report and brief sections do, so
 * the fold's markup is three self-describing sections in a row and a section
 * that has nothing to say takes its heading with it when it returns null.
 *
 * Laws: [L02] every fact arrives as a prop from the view's
 * `useSyncExternalStore` read, and nothing here subscribes; [L06] role and
 * review paint through data attributes and CSS; [L19] the row is `ArcFoldRow`
 * — the fold's one row — rather than hand-rolled chrome; [L23] the open goes
 * through `openFileInCard`, which owns the focus transfer.
 *
 * @module components/tugways/cards/session-changes/session-changes-arc-documents
 */

import "./session-changes-arc-fold.css";

import React from "react";
import { FileText, SquareArrowOutUpRight } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugSectionLabel } from "@/components/tugways/tug-section-label";
import {
  ArcFoldCell,
  ArcFoldRow,
} from "@/components/tugways/cards/session-changes/session-changes-arc-fold-row";
import { arcReviewPaints } from "@/lib/arc-review";
import { useDeckManager } from "@/deck-manager-context";
import { openFileInCard } from "@/lib/open-file-in-card";
import type { ArcDocuments } from "@/lib/changeset-types";

/** One document's row content, derived before render so the JSX stays flat. */
interface DocumentRow {
  role: "brief" | "plan" | "tasks";
  path: string;
  title: string;
  facts: string | null;
}

export interface SessionChangesArcDocumentsProps {
  /** The arc's documents, as the wire carries them — absolute paths. */
  documents: ArcDocuments;
  /** The plan's review state, when it has one. */
  review?: string | undefined;
  /** True when that plan is a task list — steps a direct arc wrote for
   *  itself, which no review stage was ever going to cover. */
  taskList?: boolean | undefined;
  /** The plan's ledger counters, for the plan row's facts line. */
  steps?: { done: number; total: number } | undefined;
}

/**
 * Compose the rows, in reading order: the brief is what the arc was asked
 * for, the plan is what it decided to do, so the brief leads.
 */
function documentRows(
  documents: ArcDocuments,
  review: string | undefined,
  taskList: boolean,
  steps: { done: number; total: number } | undefined,
): DocumentRow[] {
  const rows: DocumentRow[] = [];
  if (documents.brief !== undefined) {
    rows.push({
      role: "brief",
      path: documents.brief,
      title: documents.brief_title ?? "brief",
      facts: null,
    });
  }
  // The ledger document, whichever kind of arc wrote it: a devised `plan.md`, or
  // the `/arc` door's `tasks.md`. One row either way — it holds the same
  // place in the reading and carries the same facts.
  const ledger =
    documents.plan !== undefined
      ? ({ role: "plan", path: documents.plan, title: documents.plan_title } as const)
      : documents.tasks !== undefined
        ? ({ role: "tasks", path: documents.tasks, title: documents.tasks_title } as const)
        : null;
  if (ledger !== null) {
    // The plan states what a reader would otherwise open it to learn: whether
    // a review covers it, and how far the walk has got. The review word is
    // `arcReviewPaints`'s call, not this row's — a `reviewed` plan says
    // nothing here, and neither does a task list, which has no review stage
    // to be behind on.
    const parts: string[] = [];
    if (review !== undefined && arcReviewPaints(review, taskList)) {
      parts.push(review);
    }
    if (steps !== undefined && steps.total > 0) {
      parts.push(
        steps.done > 0
          ? `${steps.done} of ${steps.total} done`
          : steps.total === 1
            ? "1 step"
            : `${steps.total} steps`,
      );
    }
    rows.push({
      role: ledger.role,
      path: ledger.path,
      title: ledger.title ?? ledger.role,
      facts: parts.length > 0 ? parts.join(" · ") : null,
    });
  }
  return rows;
}

export function SessionChangesArcDocuments({
  documents,
  review,
  taskList = false,
  steps,
}: SessionChangesArcDocumentsProps): React.ReactElement | null {
  const store = useDeckManager();
  const rows = documentRows(documents, review, taskList, steps);
  if (rows.length === 0) return null;

  return (
    <div
      className="session-changes-arc-documents"
      data-slot="session-changes-arc-documents"
    >
      <TugSectionLabel
        label={{ name: "documents" }}
        slot="session-changes-arc-documents-label"
      />
      {rows.map((row) => {
        const caution = arcReviewPaints(review, taskList) && row.role === "plan";
        return (
          <ArcFoldRow
            key={row.role}
            hit
            wrapperProps={{
              className: "session-changes-arc-document",
              "data-slot": "session-arc-document",
              "data-role": row.role,
              ...(caution ? { "data-review": review } : {}),
              // `ArcFoldRow` is presentational by design and owns no
              // activation, so the row carries its own — and carries it on the
              // keyboard too, because a document a reader can only reach with
              // a mouse is a document the shade made harder to open than the
              // tree did.
              role: "button",
              tabIndex: 0,
              "aria-label": `Open the ${row.role} ${row.title}`,
              onClick: () => openFileInCard(store, row.path),
              onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                openFileInCard(store, row.path);
              },
            }}
            leading={
              <ArcFoldCell tone="muted">
                <FileText size={12} aria-hidden />
              </ArcFoldCell>
            }
            trailing={
              <>
                <span
                  className={
                    caution ? "arc-fold-fact arc-fold-fact-caution" : "arc-fold-fact"
                  }
                  data-slot="session-arc-document-facts"
                >
                  {row.facts ?? row.role}
                </span>
                {/* The last control on the row is the one that acts on it. */}
                <TugPushButton
                  size="2xs"
                  subtype="icon"
                  emphasis="ghost"
                  role="action"
                  aria-label={`Open the ${row.role} ${row.title} in a card`}
                  icon={<SquareArrowOutUpRight size={12} />}
                  onClick={(event) => {
                    // The wrapper opens the same document; letting the click
                    // reach it would open the card twice.
                    event?.stopPropagation();
                    openFileInCard(store, row.path);
                  }}
                />
              </>
            }
          >
            <span className="arc-fold-prose" data-slot="session-arc-document-title">
              {row.title}
            </span>
          </ArcFoldRow>
        );
      })}
    </div>
  );
}
