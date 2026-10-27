/**
 * `SendMessageToolBlock` — Layer-2 wrapper for the `SendMessage` tool.
 *
 * `SendMessage` is the assistant writing to another agent: a
 * background subagent it spawned (continuing it from its transcript),
 * a teammate, `main`, or another Claude session on this machine or
 * elsewhere. It is the second round of an `Agent` call — the launch
 * renders through `TaskToolBlock`, and without this wrapper the
 * instruction the model sent in between would be an `unknown tool`
 * caution over a JSON tree, followed by a completion notification
 * arriving from nowhere. The call carries content the user reads:
 * the recipient, the message, and a `summary` the harness asks the
 * model to write *for this transcript row*.
 *
 * Input shape (`ToolSearch select:SendMessage`, v2.1.311):
 * `{ to, message, summary?, notify_when_idle? }`. The result is a
 * short delivery text — "Message sent", a cross-session delivery
 * notice, or an error naming the recipient that did not resolve.
 *
 * Composition (Spec S03, [#bk-conformance]):
 *  - `BlockChrome` owns the frame: the tool name, the status stripe,
 *    the inline `SessionCautionBadge` (when the dispatch flagged
 *    drift), and the error band.
 *  - **Header** — the recipient as a `<code>` plus the row's label
 *    beside it: the `summary` when the model wrote one, else the
 *    first line of the message (the recipient's own preview rule).
 *    Mirrors the `Agent` header's type-plus-description reading.
 *  - **Body** — `to:` row + `summary:` row when present + `message:`
 *    (stacked `BlockPre`) + `notify when idle:` when set + the
 *    delivery result (stacked `BlockPre`).
 *  - **Chrome-level fold + copy** — collapsed by default per
 *    `tool-collapse-defaults` (the header carries the recipient and
 *    the summary, which is what the user scans). Copy collects the
 *    message text.
 *
 * Streaming / error (Spec S03):
 *  - `status === "streaming"` → body is `null` (the header dot is the in-flight signal).
 *  - `status === "error"` → chrome paints the error band; body
 *    still renders the input rows.
 *  - `status === "ready"` → header + body.
 *
 * Laws:
 *  - [L06] no React state for appearance.
 *  - [L19] `data-slot="send-message-tool-block"`. The paired `.css`
 *    file carries only the header's two-part args layout.
 *  - [L20] reuses the chrome's `--tugx-block-*` and the body-bits'
 *    shared layout values; introduces no new tokens.
 *
 * Decisions:
 *  - [D05] two-layer hybrid.
 *  - [D101] visibility policy — `sendmessage` is bespoke; it never
 *    appears in `TOOL_VISIBILITY_POLICY`.
 *
 * @module components/tugways/cards/blocks/send-message-tool-block
 */

import "./send-message-tool-block.css";

import React from "react";

import { TugTooltip } from "@/components/tugways/tug-tooltip";

import {
  BlockBody,
  BlockFieldRow,
  BlockPre,
} from "../../blocks/block-bits";
import { BlockChrome } from "../../blocks/block-chrome";
import type { ToolBlockProps } from "../../blocks/types";

// ---------------------------------------------------------------------------
// Wire-shape narrowing
// ---------------------------------------------------------------------------

/** `SendMessage` tool input (from `tool_use.input`). */
export interface SendMessageInput {
  /** Recipient — an agent name, `main`, a `name [ref]`, or a raw agentId. */
  to?: string;
  /** Plain-text message body. */
  message?: string;
  /** 5–10 word label the model wrote for this transcript row. */
  summary?: string;
  /** One-shot idle subscription on a session on this machine. */
  notify_when_idle?: boolean;
}

/**
 * Narrow the wrapper-side `unknown` input to `SendMessageInput`.
 * Defensive: returns `{}` for non-object inputs, drops mistyped
 * fields silently, and treats an empty string as absent so the
 * header never paints an empty `<code>`.
 */
export function narrowSendMessageInput(value: unknown): SendMessageInput {
  if (value === null || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const str = (field: unknown): string | undefined =>
    typeof field === "string" && field.length > 0 ? field : undefined;
  return {
    to: str(v.to),
    message: str(v.message),
    summary: str(v.summary),
    notify_when_idle:
      typeof v.notify_when_idle === "boolean" ? v.notify_when_idle : undefined,
  };
}

// ---------------------------------------------------------------------------
// Header composition
// ---------------------------------------------------------------------------

/**
 * The header's label beside the recipient: the `summary` when the
 * model wrote one, else the first non-empty line of the message —
 * the same line the recipient's human sees as a preview. `undefined`
 * when neither exists (a pure idle subscription carries no message).
 */
export function composeSendMessageLabel(
  input: SendMessageInput,
): string | undefined {
  if (input.summary !== undefined) return input.summary.trim() || undefined;
  if (input.message === undefined) return undefined;
  const firstLine = input.message
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine;
}

/**
 * The header text as one searchable unit — recipient then label,
 * adjacent, the shape the projection mirrors. `undefined` when the
 * input carries neither.
 */
export function composeSendMessageHeaderTarget(
  input: SendMessageInput,
): string | undefined {
  const label = composeSendMessageLabel(input);
  const target = `${input.to ?? ""}${label ?? ""}`;
  return target === "" ? undefined : target;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SendMessageToolBlock: React.FC<ToolBlockProps> = ({
  input,
  textOutput,
  status,
  phase,
  caution,
}) => {
  const messageInput = React.useMemo(
    () => narrowSendMessageInput(input),
    [input],
  );
  const label = composeSendMessageLabel(messageInput);

  const argsSummary =
    messageInput.to !== undefined || label !== undefined ? (
      <TugTooltip
        content={composeSendMessageHeaderTarget(messageInput) ?? ""}
        side="bottom"
        truncated
      >
        <span
          className="send-message-tool-block-args tool-call-header-clamp"
          data-tugx-findable=""
        >
          {messageInput.to !== undefined ? (
            <code data-slot="send-message-tool-block-to">{messageInput.to}</code>
          ) : null}
          {label !== undefined ? (
            <span
              data-slot="send-message-tool-block-label"
              className="send-message-tool-block-label"
            >
              {label}
            </span>
          ) : null}
        </span>
      </TugTooltip>
    ) : undefined;

  let body: React.ReactNode;
  if (status === "streaming") {
    body = null;
  } else {
    body = renderSendMessageBody({ input: messageInput, textOutput });
  }

  const copyText = messageInput.message;

  return (
    <BlockChrome
      rootSlot="send-message-tool-block"
      toolName="SendMessage"
      argsSummary={argsSummary}
      status={status}
      phase={phase}
      caution={caution}
      notice={
        status === "error" && textOutput !== undefined && textOutput.length > 0
          ? { tone: "error", text: textOutput }
          : undefined
      }
      copyText={copyText}
    >
      {body}
    </BlockChrome>
  );
};

interface RenderBodyArgs {
  input: SendMessageInput;
  textOutput: string | undefined;
}

function renderSendMessageBody({
  input,
  textOutput,
}: RenderBodyArgs): React.ReactNode {
  const hasTo = input.to !== undefined;
  const hasSummary = input.summary !== undefined;
  const hasMessage = input.message !== undefined;
  const hasNotify = input.notify_when_idle === true;
  const hasResult = textOutput !== undefined && textOutput.length > 0;
  if (!hasTo && !hasSummary && !hasMessage && !hasNotify && !hasResult) {
    return null;
  }
  return (
    <BlockBody>
      {hasTo ? (
        <BlockFieldRow label="to">
          <code>{input.to}</code>
        </BlockFieldRow>
      ) : null}
      {hasSummary ? (
        <BlockFieldRow label="summary">
          <span>{input.summary}</span>
        </BlockFieldRow>
      ) : null}
      {hasNotify ? (
        <BlockFieldRow label="notify when idle">
          <code>true</code>
        </BlockFieldRow>
      ) : null}
      {hasMessage ? (
        <BlockFieldRow label="message" layout="stacked">
          <BlockPre>{input.message}</BlockPre>
        </BlockFieldRow>
      ) : null}
      {hasResult ? (
        <BlockFieldRow label="result" layout="stacked">
          <BlockPre>{textOutput}</BlockPre>
        </BlockFieldRow>
      ) : null}
    </BlockBody>
  );
}
