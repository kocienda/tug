/**
 * `SessionErrorBlock` — inline chrome for an `error` event in the
 * transcript flow.
 *
 * The wire `error` event carries `{ message: string, recoverable:
 * boolean }`. Two readings, two affordances:
 *
 *  - **`recoverable: true`** — render with a `caution`-toned banner +
 *    a Retry button. The user can re-issue the failed action without
 *    leaving the conversation.
 *  - **`recoverable: false`** — render with a `danger`-toned banner +
 *    a Copy-error button. The error is final; the user copies the
 *    message text to escalate (paste into a bug, share with a
 *    teammate).
 *
 * Composition (Table T03 / [#bk-conformance]):
 *  - **Inline transcript flow** — no card-level chrome, just an
 *    inline row that sits in the transcript stream where the error
 *    landed. The enclosing transcript provides position.
 *  - **Tone-driven** — `data-tugx-error-tone="caution|danger"` flips
 *    the banner color via CSS; the icon and action label match.
 *
 * `onRetry` is the optional consumer callback for the recoverable
 * Retry path. When omitted, the Retry button is not rendered — the
 * recoverable banner becomes a status-only banner. The Copy button
 * has no consumer callback; it writes to the system clipboard via
 * `navigator.clipboard.writeText`.
 *
 * Laws:
 *  - [L06] no React state for appearance — the Copy "Copied!"
 *    confirmation flips a `data-copied` attribute and rotates back
 *    via CSS / a short setTimeout.
 *  - [L19] file pair (`.tsx` + `.css`),
 *    `data-slot="session-error-block"`, this docstring.
 *  - [L20] owns the `--tugx-err-*` slot family.
 *
 * @module components/tugways/chrome/session-error-block
 */

import "./session-error-block.css";

import React from "react";
import { AlertCircle, AlertTriangle, Copy, RotateCw } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";

/**
 * `RenderInput` for the `error` kind, mirrored here as the props
 * shape so the dispatch can route to the component without an
 * adapter.
 */
export interface SessionErrorBlockInputProps {
  kind: "error";
  message: string;
  recoverable: boolean;
}

export interface SessionErrorBlockProps {
  input: SessionErrorBlockInputProps;
  /**
   * Optional Retry callback. Only consulted when
   * `input.recoverable === true`. When omitted on a recoverable
   * error, the banner renders without a Retry button (status-only).
   */
  onRetry?: () => void;
}

/**
 * Briefly-visible label after Copy succeeds. Pure constant — exported
 * for tests.
 */
export const COPIED_FLASH_MS = 1200;

export const SessionErrorBlock: React.FC<SessionErrorBlockProps> = ({
  input,
  onRetry,
}) => {
  const tone = input.recoverable ? "caution" : "danger";
  const [copied, setCopied] = React.useState(false);

  const onCopy = React.useCallback(() => {
    void navigator.clipboard.writeText(input.message);
    setCopied(true);
    const timer = window.setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [input.message]);

  return (
    <div
      data-slot="session-error-block"
      data-tugx-error-tone={tone}
      className="session-error-block"
    >
      <span className="session-error-block-icon" aria-hidden="true">
        {input.recoverable ? (
          <AlertCircle size={14} />
        ) : (
          <AlertTriangle size={14} />
        )}
      </span>
      <span className="session-error-block-message">{input.message}</span>
      <div className="session-error-block-actions">
        {input.recoverable && onRetry !== undefined ? (
          <TugPushButton
            subtype="icon-text"
            emphasis="outlined"
            size="xs"
            icon={<RotateCw aria-hidden="true" />}
            onClick={onRetry}
            data-slot="session-error-block-retry"
          >
            Retry
          </TugPushButton>
        ) : null}
        {!input.recoverable ? (
          <TugPushButton
            subtype="icon-text"
            emphasis="outlined"
            size="xs"
            icon={<Copy aria-hidden="true" />}
            onClick={onCopy}
            data-copied={copied ? "true" : undefined}
            data-slot="session-error-block-copy"
          >
            {copied ? "Copied" : "Copy error"}
          </TugPushButton>
        ) : null}
      </div>
    </div>
  );
};
