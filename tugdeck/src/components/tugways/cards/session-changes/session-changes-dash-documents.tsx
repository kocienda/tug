/**
 * The fronted dash's documents, as rows you can open.
 *
 * A dash's brief and its plan were readable because they were files in the
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
 * Laws: [L02] every fact arrives as a prop from the view's
 * `useSyncExternalStore` read, and nothing here subscribes; [L06] role and
 * review paint through data attributes and CSS; [L19] the row is `TugListRow`
 * rather than hand-rolled chrome; [L23] the open goes through
 * `openFileInCard`, which owns the focus transfer.
 *
 * @module components/tugways/cards/session-changes/session-changes-dash-documents
 */

import "./session-changes-dash-documents.css";

import React from "react";
import { FileText } from "lucide-react";

import { TugListRow } from "@/components/tugways/tug-list-row";
import { useDeckManager } from "@/deck-manager-context";
import { openFileInCard } from "@/lib/open-file-in-card";
import type { DashDocuments } from "@/lib/changeset-types";

/** One document's row content, derived before render so the JSX stays flat. */
interface DocumentRow {
  role: "brief" | "plan";
  path: string;
  title: string;
  facts: string | null;
}

export interface SessionChangesDashDocumentsProps {
  /** The dash's documents, as the wire carries them — absolute paths. */
  documents: DashDocuments;
  /** The plan's review state, when it has one. */
  review?: string | undefined;
  /** The plan's ledger counters, for the plan row's facts line. */
  steps?: { done: number; total: number } | undefined;
}

/**
 * Compose the rows, in reading order: the brief is what the dash was asked
 * for, the plan is what it decided to do, so the brief leads.
 */
function documentRows(
  documents: DashDocuments,
  review: string | undefined,
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
  if (documents.plan !== undefined) {
    // The plan states what a reader would otherwise open it to learn: whether
    // a review covers it, and how far the walk has got.
    const parts: string[] = [];
    if (review !== undefined) parts.push(review);
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
      role: "plan",
      path: documents.plan,
      title: documents.plan_title ?? "plan",
      facts: parts.length > 0 ? parts.join(" · ") : null,
    });
  }
  return rows;
}

export function SessionChangesDashDocuments({
  documents,
  review,
  steps,
}: SessionChangesDashDocumentsProps): React.ReactElement | null {
  const store = useDeckManager();
  const rows = documentRows(documents, review, steps);
  if (rows.length === 0) return null;

  return (
    <div
      className="session-changes-dash-documents"
      data-slot="session-changes-dash-documents"
    >
      {rows.map((row) => (
        <TugListRow
          key={row.role}
          variant="flush"
          density="compact"
          className="session-changes-dash-document"
          data-slot="session-dash-document"
          data-role={row.role}
          {...(review !== undefined && row.role === "plan"
            ? { "data-review": review }
            : {})}
          // `TugListRow` is presentational by design and owns no activation,
          // so the row carries its own — and carries it on the keyboard too,
          // because a document a reader can only reach with a mouse is a
          // document the shade made harder to open than the tree did.
          role="button"
          tabIndex={0}
          aria-label={`Open the ${row.role} ${row.title}`}
          onClick={() => openFileInCard(store, row.path)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openFileInCard(store, row.path);
          }}
          leading={
            <FileText
              size={13}
              className="session-changes-dash-document-glyph"
              aria-hidden
            />
          }
        >
          <span className="session-changes-dash-document-block">
            <span
              className="session-changes-dash-document-title"
              data-slot="session-dash-document-title"
            >
              {row.title}
            </span>
            <span
              className="session-changes-dash-document-facts"
              data-slot="session-dash-document-facts"
            >
              {row.facts ?? row.role}
            </span>
          </span>
        </TugListRow>
      ))}
    </div>
  );
}
