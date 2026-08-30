/**
 * gallery-alert.tsx -- TugAlert demo tab for the Component Gallery.
 *
 * Shows TugAlert in all modes: basic alert, danger confirmation, caution warning,
 * OK-only (no cancel), and the ref-based imperative API.
 * All demos show a persistent result indicator.
 *
 * @module components/tugways/cards/gallery-alert
 */

import React from "react";
import { TugAlert, useTugAlert } from "@/components/tugways/tug-alert";
import type { TugAlertHandle } from "@/components/tugways/tug-alert";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { useDeckManager } from "@/deck-manager-context";
import { cardServicesStore } from "@/lib/card-services-store";

const labelStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  marginBottom: "4px",
};

const resultStyle: React.CSSProperties = {
  fontSize: "0.875rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  marginTop: "8px",
};

// ---------------------------------------------------------------------------
// GalleryAlertInner — uses useTugAlert hook (must be inside TugAlertProvider)
// ---------------------------------------------------------------------------

function GalleryAlertInner() {
  const showAlert = useTugAlert();

  const [basicResult, setBasicResult] = React.useState("none");
  const [dangerResult, setDangerResult] = React.useState("none");
  const [cautionResult, setCautionResult] = React.useState("none");
  const [okOnlyResult, setOkOnlyResult] = React.useState("none");
  const [chooserResult, setChooserResult] = React.useState("none");

  // Ref-based section
  const alertRef = React.useRef<TugAlertHandle>(null);
  const chooseRef = React.useRef<TugAlertHandle>(null);
  const [refResult, setRefResult] = React.useState("none");

  // App-level repro (TugLogout's exact shape): an effect-driven confirm on the
  // deck-root singleton, followed by the real interrupt-loop over deck cards.
  // This is the path the File-menu "Log Out…" / `/logout` take — the existing
  // demos above invoke via a card button onClick, which is subtly different.
  // The reported outcome isolates whether a click resolves the confirm and
  // whether the interrupt loop throws — no guessing.
  const deck = useDeckManager();
  const [reproNonce, setReproNonce] = React.useState(0);
  const [reproResult, setReproResult] = React.useState("none");
  React.useEffect(() => {
    if (reproNonce === 0) return;
    let cancelled = false;
    void (async () => {
      const confirmed = await showAlert({
        title: "Log Out of Claude? (repro)",
        message:
          "Effect-driven confirm on the deck-root singleton — the same path the File menu / /logout use.",
        confirmLabel: "Log Out",
        cancelLabel: "Cancel",
        confirmRole: "danger",
      });
      if (cancelled) {
        setReproResult("aborted — effect cleanup set cancelled=true");
        return;
      }
      if (!confirmed) {
        setReproResult("resolved FALSE (confirm click did not resolve true)");
        return;
      }
      // The real interrupt-first loop shape (count only — no actual
      // interrupt fired on this shared gallery deck): the real TugLogout
      // path calls `interrupt("logout")` on each interruptible card BEFORE
      // sending `claude_logout`, tagging the committed turn so its Z1B reads
      // "Stopped — logged out". A throw here is what would strand the real
      // logout before it sends.
      try {
        let interruptible = 0;
        for (const card of deck.getSnapshot().cards) {
          const services = cardServicesStore.getServices(card.id);
          if (services?.codeSessionStore.getSnapshot().canInterrupt) interruptible++;
        }
        setReproResult(
          `resolved TRUE — interrupt-first loop OK, would interrupt("logout") ${interruptible} card(s)`,
        );
      } catch (err) {
        setReproResult(`resolved TRUE — interrupt loop THREW: ${String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reproNonce, showAlert, deck]);

  async function handleBasicAlert() {
    const confirmed = await showAlert({
      title: "Replace Existing File?",
      message: 'A file named \u201cQ4 Report.pdf\u201d already exists in Downloads. Replacing it will overwrite the current version.',
    });
    setBasicResult(confirmed ? "confirmed" : "cancelled");
  }

  async function handleDangerAlert() {
    const confirmed = await showAlert({
      title: 'Delete \u201cDesign System v3\u201d?',
      message: "This card and all its contents will be permanently removed. You can't undo this action.",
      confirmLabel: "Delete",
      confirmRole: "danger",
      icon: "Trash2",
    });
    setDangerResult(confirmed ? "confirmed" : "cancelled");
  }

  async function handleCautionAlert() {
    const confirmed = await showAlert({
      title: "Discard Unsaved Changes?",
      message: 'You\'ve made changes to \u201cHomepage Copy\u201d that haven\'t been saved. Leaving now will discard them.',
      confirmLabel: "Discard",
      confirmRole: "danger",
      icon: "TriangleAlert",
    });
    setCautionResult(confirmed ? "confirmed" : "cancelled");
  }

  async function handleChooserPreview() {
    if (!chooseRef.current) return;
    const choice = await chooseRef.current.choose({
      title: "What's next?",
      icon: "Compass",
      choices: [
        {
          id: "session",
          label: "Create Session Card",
          description: "Start a new development session.",
          icon: "MessageSquareText",
          isDefault: true,
        },
        {
          id: "file",
          label: "Open Text Card",
          description: "Open an existing file to edit.",
          icon: "FileText",
        },
      ],
    });
    setChooserResult(choice ?? "cancelled");
  }

  async function handleOkOnlyAlert() {
    const confirmed = await showAlert({
      title: "Export Complete",
      message: 'Your workspace has been exported to \u201ctugtool-export-2026-03-28.zip\u201d and saved to your Downloads folder.',
      confirmLabel: "OK",
      cancelLabel: null,
    });
    setOkOnlyResult(confirmed ? "confirmed" : "cancelled");
  }

  async function handleRefAlert() {
    if (!alertRef.current) return;
    const confirmed = await alertRef.current.alert({
      title: "Send Feedback?",
      message: "This will share your last session log with the Tug team to help diagnose the issue you reported.",
      confirmLabel: "Send",
    });
    setRefResult(confirmed ? "confirmed" : "cancelled");
  }

  return (
    <div className="cg-content" data-testid="gallery-alert">

      {/* ---- 1. Basic Alert (useTugAlert hook) ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Basic Alert</TugLabel>
        <div style={labelStyle}>useTugAlert() hook — default action role, default info icon</div>
        <div style={{ display: "flex" }}>
          <TugPushButton emphasis="outlined" size="sm" onClick={handleBasicAlert}>
            Replace File
          </TugPushButton>
        </div>
        <div style={resultStyle}>
          Result: <strong>{basicResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 2. Danger Confirmation ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Danger Confirmation</TugLabel>
        <div style={labelStyle}>confirmRole="danger", icon="Trash2" — destructive action guard</div>
        <div style={{ display: "flex" }}>
          <TugPushButton emphasis="filled" role="danger" size="sm" onClick={handleDangerAlert}>
            Delete Card
          </TugPushButton>
        </div>
        <div style={resultStyle}>
          Result: <strong>{dangerResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 3. Caution Warning ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Caution Warning</TugLabel>
        <div style={labelStyle}>confirmRole="caution", icon="TriangleAlert" — potentially lossy action</div>
        <div style={{ display: "flex" }}>
          <TugPushButton emphasis="outlined" size="sm" onClick={handleCautionAlert}>
            Discard Changes
          </TugPushButton>
        </div>
        <div style={resultStyle}>
          Result: <strong>{cautionResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 4. OK-Only (no cancel) ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">OK-Only (No Cancel)</TugLabel>
        <div style={labelStyle}>cancelLabel=null — single-button acknowledgement variant</div>
        <div style={{ display: "flex" }}>
          <TugPushButton emphasis="outlined" size="sm" onClick={handleOkOnlyAlert}>
            Export Workspace
          </TugPushButton>
        </div>
        <div style={resultStyle}>
          Result: <strong>{okOnlyResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- What's next? chooser preview (multi-action choose()) ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">What's Next? (Multi-Action Chooser)</TugLabel>
        <div style={labelStyle}>
          The multi-action `choose()` form: rich rows (leading icon + title +
          description) plus Cancel, in one closed arrow ring.
        </div>
        {/* Standalone TugAlert instance for the choose() preview */}
        <TugAlert ref={chooseRef} title="What's next?" />
        <div style={{ display: "flex" }}>
          <TugPushButton
            emphasis="outlined"
            size="sm"
            onClick={handleChooserPreview}
            data-testid="gallery-preview-whats-next"
          >
            Preview What's Next
          </TugPushButton>
        </div>
        <div style={resultStyle} data-testid="whats-next-result">
          Result: <strong>{chooserResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 5. Ref-Based Imperative API ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Ref-Based Imperative API</TugLabel>
        <div style={labelStyle}>useRef&lt;TugAlertHandle&gt; + alertRef.current.alert() — alternative to provider pattern</div>
        {/* Standalone TugAlert instance for this section */}
        <TugAlert ref={alertRef} title="Send Feedback?" />
        <div style={{ display: "flex" }}>
          <TugPushButton emphasis="outlined" size="sm" onClick={handleRefAlert}>
            Send Feedback
          </TugPushButton>
        </div>
        <div style={resultStyle}>
          Result: <strong>{refResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 6. App-level effect-driven confirm (logout repro) ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">App-Level Confirm (Logout Repro)</TugLabel>
        <div style={labelStyle}>
          Effect-driven showAlert on the deck-root singleton + the real
          interrupt-loop — the exact TugLogout path (File menu / /logout).
        </div>
        <div style={{ display: "flex" }}>
          <TugPushButton
            emphasis="filled"
            role="danger"
            size="sm"
            onClick={() => setReproNonce((n) => n + 1)}
          >
            Simulate Logout Confirm
          </TugPushButton>
        </div>
        <div style={resultStyle}>
          Result: <strong>{reproResult}</strong>
        </div>
      </div>

    </div>
  );
}

// ---------------------------------------------------------------------------
// GalleryAlert — public export
// ---------------------------------------------------------------------------

/**
 * GalleryAlert — TugAlert demo tab.
 *
 * Delegates to GalleryAlertInner which uses useTugAlert(). The TugAlertProvider
 * is already in the root render tree (added in Dash 2), so the hook works here.
 */
export function GalleryAlert() {
  return <GalleryAlertInner />;
}
