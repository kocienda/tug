/**
 * gallery-banner.tsx -- TugBanner demo tab for the Component Gallery.
 *
 * Shows TugBanner in all modes: status variant with three tones (danger, caution,
 * default), status variant with icon, and error variant with sample stack trace.
 *
 * All demos use the `contained` prop to prevent the banner from blocking the app
 * or setting `inert` on the real deck canvas. Each demo renders inside a
 * mini-viewport wrapper div.
 *
 * @module components/tugways/cards/gallery-banner
 */

import { WifiOff } from "lucide-react";
import React from "react";
import { TugBanner } from "@/components/tugways/tug-banner";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const labelStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  marginBottom: "4px",
};

/** Mini-viewport container for contained status banner demos. */
const miniViewport: React.CSSProperties = {
  position: "relative",
  overflow: "hidden",
  height: "80px",
  border: "1px solid var(--tug7-element-global-border-normal-default-rest)",
  borderRadius: "6px",
  background: "var(--tug7-surface-global-primary-normal-sunken-rest)",
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
      App content behind banner
    </div>
  );
}

// ---------------------------------------------------------------------------
// GalleryBanner
// ---------------------------------------------------------------------------

export function GalleryBanner() {
  const [dangerVisible, setDangerVisible] = React.useState(false);
  const [cautionVisible, setCautionVisible] = React.useState(false);
  const [defaultVisible, setDefaultVisible] = React.useState(false);
  const [iconVisible, setIconVisible] = React.useState(false);
  const [errorVisible, setErrorVisible] = React.useState(false);

  const timerRefs = React.useRef<ReturnType<typeof setTimeout>[]>([]);

  React.useEffect(() => {
    const timers = timerRefs.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
    };
  }, []);

  function showFor3s(setter: React.Dispatch<React.SetStateAction<boolean>>) {
    setter(true);
    const t = setTimeout(() => setter(false), 3000);
    timerRefs.current.push(t);
  }

  // Long simulated stack trace — intentionally sized well past the
  // mini-viewport detail panel so the body scrolls and the pinned
  // footer stays visible at the bottom. Mirrors a realistic React
  // fiber unwind pulled from a dev build.
  const sampleStack = [
    "TypeError: undefined is not an object (evaluating 'state.perRoute[state.currentRoute]')",
    "    at onRestore (tug-prompt-entry.tsx:217:39)",
    "    at TugCard.onRestore (tug-pane.tsx:356:48)",
    "    at react_stack_bottom_frame (react-dom-client.js:18567:26)",
    "    at runWithFiberInDEV (react-dom-client.js:999:23)",
    "    at commitHookEffectListMount (react-dom-client.js:9411:180)",
    "    at commitHookLayoutEffects (react-dom-client.js:9391:85)",
    "    at commitLayoutEffectOnFiber (react-dom-client.js:9904:49)",
    "    at recursivelyTraverseLayoutEffects (react-dom-client.js:10792:38)",
    "    at commitLayoutEffectOnFiber (react-dom-client.js:9992:45)",
    "    at recursivelyTraverseLayoutEffects (react-dom-client.js:10792:38)",
    "    at commitLayoutEffectOnFiber (react-dom-client.js:9903:45)",
    "    at recursivelyTraverseLayoutEffects (react-dom-client.js:10792:38)",
    "    at commitLayoutEffectOnFiber (react-dom-client.js:9992:45)",
    "    at recursivelyTraverseLayoutEffects (react-dom-client.js:10792:38)",
    "    at commitLayoutEffectOnFiber (react-dom-client.js:9992:45)",
    "    at recursivelyTraverseLayoutEffects (react-dom-client.js:10792:38)",
    "    at commitLayoutEffectOnFiber (react-dom-client.js:10074:45)",
    "    at recursivelyTraverseLayoutEffects (react-dom-client.js:10792:38)",
    "    at commitLayoutEffectOnFiber (react-dom-client.js:9903:45)",
    "    at recursivelyTraverseLayoutEffects (react-dom-client.js:10792:38)",
    "    at commitLayoutEffectOnFiber (react-dom-client.js:9903:45)",
    "    at recursivelyTraverseLayoutEffects (react-dom-client.js:10792:38)",
    "    at commitLayoutEffectOnFiber (react-dom-client.js:10074:45)",
    "    at recursivelyTraverseLayoutEffects (react-dom-client.js:10792:38)",
    "    at commitLayoutEffectOnFiber (react-dom-client.js:10074:45)",
    "    at recursivelyTraverseLayoutEffects (react-dom-client.js:10792:38)",
    "    at commitLayoutEffectOnFiber (react-dom-client.js:9907:45)",
    "    at recursivelyTraverseLayoutEffects (react-dom-client.js:10792:38)",
    "    at commitLayoutEffectOnFiber (react-dom-client.js:9963:45)",
    "    at flushLayoutEffects (react-dom-client.js:12924:145)",
    "    at commitRoot (react-dom-client.js:12803:29)",
    "    at commitRootWhenReady (react-dom-client.js:12016:19)",
    "    at performWorkOnRoot (react-dom-client.js:11950:36)",
    "    at performWorkOnRootViaSchedulerTask (react-dom-client.js:13505:26)",
    "    at performWorkUntilDeadline (react-dom-client.js:36:58)",
  ].join("\n");

  /** Tall mini-viewport so the contained error variant has room to render. */
  const errorMiniViewport: React.CSSProperties = {
    ...miniViewport,
    height: "420px",
  };

  return (
    <div className="cg-content" data-testid="gallery-banner">

      {/* ---- 1. Status variant — danger tone (default) ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Status — Danger Tone</TugLabel>
        <div style={labelStyle}>Solid-fill strip. Bold text. Full-opacity — impossible to miss.</div>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            onClick={() => setDangerVisible((v) => !v)}
          >
            {dangerVisible ? "Hide Banner" : "Show Banner"}
          </TugPushButton>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            onClick={() => showFor3s(setDangerVisible)}
          >
            Show for 3s
          </TugPushButton>
        </div>
        <div style={miniViewport} data-slot="deck-canvas">
          <MiniContent />
          <TugBanner
            contained
            open={dangerVisible}
            kind="status"
            tone="danger"
            message="Connection lost — attempting to reconnect..."
          />
        </div>
      </div>

      <TugSeparator />

      {/* ---- 2. Status variant — caution tone ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Status — Caution Tone</TugLabel>
        <div style={labelStyle}>tone="caution" — solid yellow palette.</div>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            onClick={() => setCautionVisible((v) => !v)}
          >
            {cautionVisible ? "Hide Banner" : "Show Banner"}
          </TugPushButton>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            onClick={() => showFor3s(setCautionVisible)}
          >
            Show for 3s
          </TugPushButton>
        </div>
        <div style={miniViewport}>
          <MiniContent />
          <TugBanner
            contained
            open={cautionVisible}
            kind="status"
            tone="caution"
            message="Maintenance mode — reconnecting in 30s..."
          />
        </div>
      </div>

      <TugSeparator />

      {/* ---- 3. Status variant — default tone ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Status — Default Tone</TugLabel>
        <div style={labelStyle}>tone="default" — neutral overlay palette.</div>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            onClick={() => setDefaultVisible((v) => !v)}
          >
            {defaultVisible ? "Hide Banner" : "Show Banner"}
          </TugPushButton>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            onClick={() => showFor3s(setDefaultVisible)}
          >
            Show for 3s
          </TugPushButton>
        </div>
        <div style={miniViewport}>
          <MiniContent />
          <TugBanner
            contained
            open={defaultVisible}
            kind="status"
            tone="default"
            message="Syncing workspace..."
          />
        </div>
      </div>

      <TugSeparator />

      {/* ---- 4. Status variant with icon ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Status with Icon</TugLabel>
        <div style={labelStyle}>icon="wifi-off" — Lucide icon rendered inline in strip.</div>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            onClick={() => setIconVisible((v) => !v)}
          >
            {iconVisible ? "Hide Banner" : "Show Banner"}
          </TugPushButton>
        </div>
        <div style={miniViewport}>
          <MiniContent />
          <TugBanner
            contained
            open={iconVisible}
            kind="status"
            tone="danger"
            message="No connection — check your network"
            icon={<WifiOff />}
          />
        </div>
      </div>

      <TugSeparator />

      {/* ---- 5. Error variant ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Error Variant</TugLabel>
        <div style={labelStyle}>
          variant="error" — bold strip at top (same urgency as status), centered detail panel below.
          The body scrolls; the footer (Reload) stays pinned at the bottom-right.
        </div>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <TugPushButton
            size="sm"
            emphasis="outlined"
            role="danger"
            onClick={() => setErrorVisible((v) => !v)}
          >
            {errorVisible ? "Hide Error" : "Show Error"}
          </TugPushButton>
        </div>
        <div style={errorMiniViewport}>
          <MiniContent />
          {errorVisible && (
            <TugBanner
              contained
              open={true}
              kind="error"
              tone="danger"
              message="undefined is not an object (evaluating 'state.perRoute[state.currentRoute]')"
              footer={
                <TugPushButton
                  size="sm"
                  emphasis="outlined"
                  role="danger"
                  onClick={() => setErrorVisible(false)}
                >
                  Reload (demo only)
                </TugPushButton>
              }
            >
              <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                {sampleStack}
              </pre>
            </TugBanner>
          )}
        </div>
      </div>

    </div>
  );
}
