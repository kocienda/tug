/**
 * gallery-confirm-popover.tsx -- TugConfirmPopover demo tab for the Component Gallery.
 *
 * Shows TugConfirmPopover in all modes: danger confirmation, action confirmation,
 * custom labels, positioning (bottom vs top), and the imperative Promise API.
 * Every demo drives the popover through the imperative
 * `TugConfirmPopoverHandle.confirm()` API and awaits the result to update a
 * persistent result indicator.
 *
 * @module components/tugways/cards/gallery-confirm-popover
 */

import React from "react";
import {
  TugConfirmPopover,
  type TugConfirmPopoverHandle,
} from "@/components/tugways/tug-confirm-popover";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

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
// GalleryConfirmPopover
// ---------------------------------------------------------------------------

export function GalleryConfirmPopover() {
  const [dangerResult, setDangerResult] = React.useState("none");
  const [actionResult, setActionResult] = React.useState("none");
  const [customResult, setCustomResult] = React.useState("none");
  const [bottomResult, setBottomResult] = React.useState("none");
  const [topResult, setTopResult] = React.useState("none");
  const [promiseResult, setPromiseResult] = React.useState("none");

  const dangerRef = React.useRef<TugConfirmPopoverHandle>(null);
  const actionRef = React.useRef<TugConfirmPopoverHandle>(null);
  const customRef = React.useRef<TugConfirmPopoverHandle>(null);
  const bottomRef = React.useRef<TugConfirmPopoverHandle>(null);
  const topRef = React.useRef<TugConfirmPopoverHandle>(null);
  const promiseRef = React.useRef<TugConfirmPopoverHandle>(null);

  // Imperative confirm() bridges. Each handler opens the popover and
  // awaits the result, then updates the local display state. Triggers
  // go through the popover's Radix trigger (to anchor the positioning)
  // AND through confirm() (to set the resolver). Both converge on the
  // same open state.
  async function handleDanger() {
    const confirmed = await dangerRef.current?.confirm();
    setDangerResult(confirmed ? "confirmed" : "cancelled");
  }

  async function handleAction() {
    const confirmed = await actionRef.current?.confirm();
    setActionResult(confirmed ? "confirmed" : "cancelled");
  }

  async function handleCustom() {
    const confirmed = await customRef.current?.confirm();
    setCustomResult(confirmed ? "discarded" : "kept editing");
  }

  async function handleBottom() {
    const confirmed = await bottomRef.current?.confirm();
    setBottomResult(confirmed ? "confirmed" : "cancelled");
  }

  async function handleTop() {
    const confirmed = await topRef.current?.confirm();
    setTopResult(confirmed ? "confirmed" : "cancelled");
  }

  async function handlePromise() {
    const confirmed = await promiseRef.current?.confirm();
    setPromiseResult(confirmed ? "confirmed" : "cancelled");
  }

  return (
    <div className="cg-content" data-testid="gallery-confirm-popover">

      {/* ---- 1. Danger Confirmation ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Danger Confirmation</TugLabel>
        <div style={labelStyle}>Default role="danger" — delete action guard</div>
        <div style={{ display: "flex", alignItems: "flex-start" }}>
          <TugConfirmPopover
            ref={dangerRef}
            message="Are you sure?"
            confirmLabel="Delete"
            confirm={{ role: "danger" }}
          >
            <TugPushButton role="danger" emphasis="filled" size="sm" onClick={handleDanger}>
              Delete Item
            </TugPushButton>
          </TugConfirmPopover>
        </div>
        <div style={resultStyle}>
          Result: <strong>{dangerResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 2. Action Confirmation ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Action Confirmation</TugLabel>
        <div style={labelStyle}>confirm.role="action" — non-destructive confirmation</div>
        <div style={{ display: "flex", alignItems: "flex-start" }}>
          <TugConfirmPopover
            ref={actionRef}
            message="Are you sure?"
            confirmLabel="Publish"
            confirm={{ role: "action" }}
          >
            <TugPushButton role="action" emphasis="filled" size="sm" onClick={handleAction}>
              Publish
            </TugPushButton>
          </TugConfirmPopover>
        </div>
        <div style={resultStyle}>
          Result: <strong>{actionResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 3. Custom Labels ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Custom Labels</TugLabel>
        <div style={labelStyle}>Custom confirmLabel and cancelLabel</div>
        <div style={{ display: "flex", alignItems: "flex-start" }}>
          <TugConfirmPopover
            ref={customRef}
            message="Are you sure?"
            confirmLabel="Discard"
            cancelLabel="Keep Editing"
          >
            <TugPushButton emphasis="outlined" size="sm" onClick={handleCustom}>
              Discard Changes
            </TugPushButton>
          </TugConfirmPopover>
        </div>
        <div style={resultStyle}>
          Result: <strong>{customResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 4. Positioning ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Positioning</TugLabel>
        <div style={labelStyle}>side="bottom" (default) vs side="top" — buttons always nearest to trigger</div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
          <TugConfirmPopover
            ref={bottomRef}
            message="Are you sure?"
            confirmLabel="Confirm"
            confirm={{ role: "action" }}
          >
            <TugPushButton emphasis="outlined" size="sm" onClick={handleBottom}>
              Bottom (default)
            </TugPushButton>
          </TugConfirmPopover>

          <TugConfirmPopover
            ref={topRef}
            message="Are you sure?"
            confirmLabel="Confirm"
            confirm={{ role: "action" }}
            side="top"
          >
            <TugPushButton emphasis="outlined" size="sm" onClick={handleTop}>
              Top
            </TugPushButton>
          </TugConfirmPopover>
        </div>
        <div style={resultStyle}>
          Bottom: <strong>{bottomResult}</strong> | Top: <strong>{topResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 5. Promise API ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Promise API</TugLabel>
        <div style={labelStyle}>Imperative confirm() via useRef — resolves true/false</div>
        <div style={{ display: "flex", alignItems: "flex-start" }}>
          <TugConfirmPopover
            ref={promiseRef}
            message="Are you sure?"
            confirmLabel="Delete"
            confirm={{ role: "danger" }}
          >
            <TugPushButton
              role="danger"
              emphasis="filled"
              size="sm"
              onClick={handlePromise}
            >
              Delete (Promise)
            </TugPushButton>
          </TugConfirmPopover>
        </div>
        <div style={resultStyle}>
          Result: <strong>{promiseResult}</strong>
        </div>
      </div>

    </div>
  );
}
