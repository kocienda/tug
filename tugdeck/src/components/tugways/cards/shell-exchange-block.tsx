/**
 * `ShellExchangeBlock` — the body of a `shell`-origin transcript turn ([P06]).
 *
 * Renders one `$`-route command/output exchange with the SAME chrome as every
 * other tool block ([D05]/[D111]): a `BlockChrome` header carrying the command
 * (the `$` prompt sigil + the command text, in the header — not a bespoke line
 * above the block, exactly as `BashToolBlock` puts its command in the header),
 * a right-aligned Add-to-context + Copy affordance cluster, and an embedded
 * `TerminalBlock` body for the combined output. The exchange's exit status and
 * duration are NOT drawn inside the block — they ride the Z1B end-state row
 * below it (`SessionZ1B participant="shell"`), the same place a Claude turn shows
 * its OK/Error badge + timing.
 *
 * The block carries no tool NAME in its header: the containing
 * `participant="shell"` transcript row already names it "Shell", so a repeated
 * name would be redundant (unlike a `Bash` block, which sits under the shared
 * "Code" assistant identity). The empty name collapses out of the header flow.
 *
 * While the exchange is in flight the header's lifecycle dot pulses (the
 * standard streaming signal) and there is no body; once it settles the body
 * mounts with the final output. Add-to-context ([P08]) is the only path into
 * Claude's context and appears once settled.
 */

import type React from "react";
import {
  Check as checkIconNode,
  CloudUpload as addToContextIconNode,
  Send as sendAsMessageIconNode,
} from "lucide";

import { TerminalBlock } from "../body-kinds/terminal-block";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  TugSpriteIcon,
  type LucideIconNode,
} from "@/components/tugways/tug-sprite-icon";
import type { ToolCallPhase } from "@/lib/code-session-store/tool-call-phase-visual";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";
import { BlockChrome } from "../blocks/block-chrome";
import { deriveShellExchangeView } from "./shell-exchange-view";
import "./shell-exchange-block.css";

/** Icon-only Add-to-context toggle — stage this exchange to ride the next `❯`
 *  submission as attributed context, or un-stage it. Matches the Copy/chevron
 *  scale so the header actions read as one matched cluster. `cloud-upload` is
 *  the one glyph for this gesture everywhere it appears ([P08]). */
function ShellAddToContextButton({
  staged,
  onToggle,
}: {
  staged: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <TugPushButton
      data-slot="shell-exchange-add-context"
      aria-pressed={staged}
      icon={
        <TugSpriteIcon
          name={staged ? "check" : "cloud-upload"}
          node={(staged ? checkIconNode : addToContextIconNode) as LucideIconNode}
        />
      }
      subtype="icon"
      emphasis="ghost"
      size="xs"
      aria-label={
        staged
          ? "Remove this exchange from the next submission's context"
          : "Add this exchange to the next submission's context"
      }
      title={staged ? "Staged for the next submission" : "Add to context"}
      onClick={onToggle}
    />
  );
}

export function ShellExchangeBlock({
  message,
  onToggleContext,
  onSendAsMessage,
  staged = false,
}: {
  message: ShellExchangeMessage;
  /** Add-to-context toggle ([P08]) — omitted where no queue. */
  onToggleContext?: () => void;
  /**
   * Send the original command to Claude as a message instead ([P09]). Rendered
   * only for an auto-routed row (`message.autoRouted`); dispatches the raw text
   * via `codeSessionStore.send`, undoing a classifier misroute in one click.
   */
  onSendAsMessage?: () => void;
  /** Whether this exchange is currently staged. */
  staged?: boolean;
}): React.ReactElement {
  const view = deriveShellExchangeView(message);
  const hasOutput = view.terminal.stdout.length > 0;

  // The command sits in the header (parity with `BashToolBlock`) — mono, no
  // `$` sigil (the `Shell` row identity already frames it as a shell command).
  // Clamps while the block is collapsed; a long command wraps when expanded.
  // `data-tugx-findable` opts the command text into transcript Find. It
  // rides the header, so it stays searchable while the exchange is
  // collapsed — only the output, unmounted with the body, is gated.
  const command = (
    <code
      className="shell-exchange-command tool-call-header-clamp"
      data-tugx-findable=""
    >
      <span className="shell-exchange-command-text">{view.command}</span>
    </code>
  );

  // Add-to-context is a settled-exchange gesture ([P08]) — an in-flight
  // exchange has no output or exit to compose yet.
  const addContextButton =
    onToggleContext !== undefined && !view.inFlight ? (
      <ShellAddToContextButton staged={staged} onToggle={onToggleContext} />
    ) : null;
  // Auto-route escape hatch ([P09]): a one-click "send this as a message
  // instead" for a row the PATH classifier routed here from the prompt entry.
  // Rendered whenever the row was auto-routed, in-flight or settled, so the
  // undo is reachable the instant the row appears. Icon-only at the Copy /
  // chevron scale, so the header stays one matched cluster of glyphs — the
  // label rides the tooltip. The paper plane is deliberately NOT
  // `cloud-upload`: with no visible labels, the glyph carries the whole
  // distinction — this fires a turn now with the user's original text, where
  // add-to-context stages this row's output for later.
  const sendAsMessageButton =
    message.autoRouted === true && onSendAsMessage !== undefined ? (
      <TugPushButton
        data-slot="shell-exchange-send-as-message"
        icon={
          <TugSpriteIcon
            name="send"
            node={sendAsMessageIconNode as LucideIconNode}
          />
        }
        subtype="icon"
        emphasis="ghost"
        size="xs"
        aria-label="Send the original text to Claude as a message instead"
        title="Send as message"
        onClick={onSendAsMessage}
      />
    ) : null;
  const headerActions =
    sendAsMessageButton !== null || addContextButton !== null ? (
      <>
        {addContextButton}
        {sendAsMessageButton}
      </>
    ) : null;

  // Lifecycle: pulse while running, then success / danger from the exit.
  const phase: ToolCallPhase = view.inFlight
    ? "in_flight"
    : view.failed
      ? "error"
      : "success";

  const body = view.inFlight ? null : hasOutput ? (
    // Key on the settled phase so the mount-once `TerminalBlock` mounts with
    // the final output (the in-flight header had no body).
    <TerminalBlock
      key={`${message.exchangeId}-settled`}
      data={view.terminal}
      embedded
      findable
      className="shell-exchange-terminal"
    />
  ) : null;

  return (
    <BlockChrome
      rootSlot="shell-exchange-block"
      toolName=""
      command={command}
      phase={phase}
      status={view.inFlight ? "streaming" : view.failed ? "error" : "ready"}
      headerActions={headerActions}
      // The header's built-in Copy writes the output; a no-output exchange
      // (`cd`) has nothing to copy, so no Copy renders there.
      copyText={hasOutput ? view.terminal.stdout : undefined}
    >
      {body}
    </BlockChrome>
  );
}
