/**
 * gallery-card-banner.tsx — TugPaneBanner demo tab for the Component Gallery.
 *
 * Shows TugPaneBanner in all modes: error variant with TugAlert-style detail
 * panel (icon + title + message + dismiss action) across the three tones
 * (danger, caution, default), status variant as a strip-only attention bar,
 * and status variant with a soft Dismiss footer (a non-blocking notice the
 * user acknowledges — e.g. the forward-compat unknown-event banner).
 *
 * All demos use the `contained` prop so the banner renders inline inside
 * the mini-viewport instead of portaling into the gallery card's body and
 * applying `inert`. See tug-pane-banner.tsx — contained mode skips both.
 *
 * @module components/tugways/cards/gallery-card-banner
 */

import { AlertTriangle, CloudOff, RefreshCw, TriangleAlert, Unplug } from "lucide-react";
import React from "react";
import { TugPaneBanner } from "@/components/tugways/tug-pane-banner";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const labelStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  marginBottom: "4px",
};

/** Tall mini-viewport container — large enough to show the detail panel. */
const miniViewport: React.CSSProperties = {
  position: "relative",
  overflow: "hidden",
  height: "420px",
  border: "1px solid var(--tug7-element-global-border-normal-default-rest)",
  borderRadius: "6px",
  background: "var(--tug7-surface-global-primary-normal-sunken-rest)",
};

/** Short mini-viewport for the strip-only status variant. */
const miniViewportShort: React.CSSProperties = {
  ...miniViewport,
  height: "120px",
};

/** Placeholder content inside the mini-viewport so there's something to dim. */
function MiniContent() {
  return (
    <div
      style={{
        padding: "12px 16px",
        fontSize: "0.8rem",
        color: "var(--tug7-element-global-text-normal-muted-rest)",
        userSelect: "none",
      }}
    >
      Card content behind banner
    </div>
  );
}

// ---------------------------------------------------------------------------
// GalleryCardBanner
// ---------------------------------------------------------------------------

export function GalleryCardBanner() {
  const [dangerVisible, setDangerVisible] = React.useState(false);
  const [cautionVisible, setCautionVisible] = React.useState(false);
  const [defaultVisible, setDefaultVisible] = React.useState(false);
  const [statusVisible, setStatusVisible] = React.useState(false);
  const [statusDismissVisible, setStatusDismissVisible] = React.useState(false);

  return (
    <div className="cg-content" data-testid="gallery-card-banner">

      {/* ---- 1. Error variant — danger tone ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Error — Danger Tone</TugLabel>
        <div style={labelStyle}>
          variant="error" + tone="danger". Strip at top, TugAlert-style
          detail panel (icon + title + message) centered below. Single
          Dismiss action.
        </div>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            onClick={() => setDangerVisible((v) => !v)}
          >
            {dangerVisible ? "Hide Banner" : "Show Banner"}
          </TugPushButton>
        </div>
        <div style={miniViewport}>
          <MiniContent />
          <TugPaneBanner
            contained
            open={dangerVisible}
            kind="error"
            tone="danger"
            label="Connection lost"
            message="transport closed"
            detailIcon={<Unplug />}
            detailTitle="Connection lost"
            footer={
              <TugPushButton
                size="sm"
                emphasis="outlined"
                role="danger"
                onClick={() => setDangerVisible(false)}
              >
                Dismiss
              </TugPushButton>
            }
          >
            <p>
              The card can&apos;t reach its session. Dismiss to continue;
              close and reopen the card to retry.
            </p>
          </TugPaneBanner>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 2. Error variant — caution tone ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Error — Caution Tone</TugLabel>
        <div style={labelStyle}>tone="caution" — yellow strip, dark text.</div>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            onClick={() => setCautionVisible((v) => !v)}
          >
            {cautionVisible ? "Hide Banner" : "Show Banner"}
          </TugPushButton>
        </div>
        <div style={miniViewport}>
          <MiniContent />
          <TugPaneBanner
            contained
            open={cautionVisible}
            kind="error"
            tone="caution"
            label="Stale session"
            message="resume no longer applies"
            detailIcon={<TriangleAlert />}
            detailTitle="Session state is stale"
            footer={
              <TugPushButton
                size="sm"
                emphasis="outlined"
                role="action"
                onClick={() => setCautionVisible(false)}
              >
                Acknowledge
              </TugPushButton>
            }
          >
            <p>
              Something shifted underneath this session. Acknowledge to
              continue with reduced fidelity, or restart the card for a
              clean run.
            </p>
          </TugPaneBanner>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 3. Error variant — default tone ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Error — Default Tone</TugLabel>
        <div style={labelStyle}>tone="default" — neutral overlay palette.</div>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            onClick={() => setDefaultVisible((v) => !v)}
          >
            {defaultVisible ? "Hide Banner" : "Show Banner"}
          </TugPushButton>
        </div>
        <div style={miniViewport}>
          <MiniContent />
          <TugPaneBanner
            contained
            open={defaultVisible}
            kind="error"
            tone="default"
            label="Offline"
            message="syncing paused"
            detailIcon={<CloudOff />}
            detailTitle="Workspace is offline"
            footer={
              <TugPushButton
                size="sm"
                emphasis="outlined"
                onClick={() => setDefaultVisible(false)}
              >
                OK
              </TugPushButton>
            }
          >
            <p>
              The card stopped syncing while you were away. Cached content
              is shown; changes will resume when the connection returns.
            </p>
          </TugPaneBanner>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 4. Status variant — strip-only ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Status Variant</TugLabel>
        <div style={labelStyle}>
          variant="status" — strip-only, no detail panel. Useful for
          non-blocking card-level notices.
        </div>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            onClick={() => setStatusVisible((v) => !v)}
          >
            {statusVisible ? "Hide Banner" : "Show Banner"}
          </TugPushButton>
        </div>
        <div style={miniViewportShort}>
          <MiniContent />
          <TugPaneBanner
            contained
            open={statusVisible}
            kind="status"
            tone="caution"
            label="Reconnecting"
            message="attempting to restore the session..."
            icon={<RefreshCw />}
          />
        </div>
      </div>

      <TugSeparator />

      {/* ---- 5. Status variant — soft Dismiss footer ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Status — Dismissible</TugLabel>
        <div style={labelStyle}>
          variant="status" + footer — a non-blocking notice with a
          left-aligned Dismiss row below the strip (no focus trap, no
          backdrop). Used by the forward-compat unknown-event banner.
        </div>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            onClick={() => setStatusDismissVisible((v) => !v)}
          >
            {statusDismissVisible ? "Hide Banner" : "Show Banner"}
          </TugPushButton>
        </div>
        <div style={miniViewportShort}>
          <MiniContent />
          <TugPaneBanner
            contained
            open={statusDismissVisible}
            kind="status"
            tone="caution"
            icon={<AlertTriangle />}
            label="Unsupported event"
            message={'This session-card build doesn’t understand event "future_telemetry" yet. The session is unaffected.'}
            footer={
              <TugPushButton
                size="sm"
                emphasis="outlined"
                onClick={() => setStatusDismissVisible(false)}
              >
                Dismiss
              </TugPushButton>
            }
          />
        </div>
      </div>

    </div>
  );
}
