/**
 * `SessionReauditBlock` — the engine's re-audit, as one live block in the
 * transcript of the card that holds the arc.
 *
 * When a landing on the base makes a finished arc's audit stale, tugcast
 * re-audits the arc without spending a turn and tells this card through one
 * `/arc-reaudit <arc>` shell-ledger row it rewrites at every transition. The
 * card upserts the row's turn by its receipt id, so the story is one block
 * from the base move to the verdict.
 *
 * **Two sources, one model.** The row is the durable record; the arc's
 * `restamp` fact on the changeset aggregate is the live one. While the wire
 * still knows the row's run the block draws from it — the phase, a row per
 * surface, the clock and the horizon, the wait and its reason — and once it
 * does not, from the row's own record. `reauditView` makes that decision and
 * composes every sentence, so this file only lays the model out.
 *
 * The session is resolved the way the arc receipt resolves it: the card's id
 * from `CardIdContext`, its binding from `cardSessionBindingStore`, then the
 * arc through `useArcForSession` — each an external store read through
 * `useSyncExternalStore` ([L02]). Status colour and the running pulse are
 * attributes and CSS ([L06]). The clock is a leaf that subscribes to the
 * shared tick only while the block is live, so a settled row holds no
 * interval open.
 *
 * Attributed to the **wheel**, as the arc receipt is: the re-audit shelled
 * nothing on the card's behalf, so it wears no `Shell` identifier and no
 * exit end-state. A parse miss falls back to the generic block.
 *
 * @module components/tugways/cards/session-reaudit-block
 */

import type React from "react";
import { useContext } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { BlockChrome } from "@/components/tugways/blocks/block-chrome";
import { ReauditRows } from "@/components/tugways/reaudit-rows";
import { useArcForSession } from "@/lib/arc-session-index";
import { CardIdContext } from "@/lib/card-id-context";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";
import type { ToolCallPhase } from "@/lib/code-session-store/tool-call-phase-visual";
import { useLiveTick } from "@/lib/live-tick";
import {
  matchesReauditRow,
  parseReauditRow,
  reauditFooter,
  reauditView,
  type ReauditModel,
  type ReauditRow,
  type ReauditViewState,
} from "@/lib/reaudit-row";
import { registerCommandBlock, type CommandBlockProps } from "./session-command-block-registry";
import { ShellExchangeBlock } from "./shell-exchange-block";
import "./session-reaudit-block.css";

/** The header dot's phase, by the model's state. */
export function reauditPhase(state: ReauditViewState): ToolCallPhase {
  switch (state) {
    case "running":
    case "finishing":
      return "in_flight";
    case "waiting":
      return "awaiting";
    case "verified":
      return "success";
    case "seated":
    case "released":
      return "error";
    case "interrupted":
      return "interrupted";
    case "answered":
      return "idle";
  }
}

/** The live footer, ticking. Mounted only while the model is live. */
function ReauditClock({ model }: { model: ReauditModel }): React.ReactElement {
  const now = useLiveTick();
  return <p className="reaudit-block-footer">{reauditFooter(model, now) ?? ""}</p>;
}

/** The card's bound session, read from the binding store. */
function useCardSession(): string | null {
  const cardId = useContext(CardIdContext);
  return useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    () => (cardId === null ? null : (cardSessionBindingStore.getBinding(cardId)?.tugSessionId ?? null)),
    () => null,
  );
}

function ReauditBlockView({
  row,
  message,
}: {
  row: ReauditRow;
  message: ShellExchangeMessage;
}): React.ReactElement {
  const session = useCardSession();
  const fact = useArcForSession(session);
  const model = reauditView(row, fact?.restamp ?? null, fact?.name ?? null);
  const identity = (
    <span className="reaudit-block-identity">
      <span className="reaudit-block-title">
        Re-audit · <span data-tugx-findable="">{model.arc}</span>
      </span>
      <span className="reaudit-block-status" data-state={model.state}>
        {model.statusWord}
      </span>
    </span>
  );
  return (
    <BlockChrome
      rootSlot="reaudit-block"
      variant="receipt"
      identity={identity}
      phase={reauditPhase(model.state)}
      status="ready"
      copyText={message.output}
    >
      <div className="reaudit-block-body" data-state={model.state}>
        <p className="reaudit-block-headline" data-tugx-findable="">
          {model.headline}
        </p>
        {model.phaseLine !== null ? (
          <p className="reaudit-block-phase">{model.phaseLine}</p>
        ) : null}
        <ReauditRows surfaces={model.surfaces} />
        {model.live ? <ReauditClock model={model} /> : null}
        {model.verdict !== null ? (
          <p className="reaudit-block-verdict" data-tugx-findable="">
            {model.verdict}
          </p>
        ) : null}
      </div>
    </BlockChrome>
  );
}

export function SessionReauditBlock(props: CommandBlockProps): React.ReactElement {
  const row = parseReauditRow(props.message.output);
  if (row === null) return <ShellExchangeBlock {...props} />;
  return <ReauditBlockView row={row} message={props.message} />;
}

/**
 * The block's searchable text, in render order: the arc, the headline, the
 * surface names and failures, and the verdict — read from the row, which is
 * what a restored transcript holds. `null` on a parse miss, which renders
 * and projects as a plain exchange.
 */
export function reauditFindParts(message: ShellExchangeMessage): string[] | null {
  const row = parseReauditRow(message.output);
  if (row === null) return null;
  const model = reauditView(row, null, null);
  const parts = [row.arc, model.headline];
  for (const surface of model.surfaces) {
    parts.push(surface.name);
    if (surface.status === "fail" && (surface.title !== null || surface.message !== null)) {
      parts.push([surface.title, surface.message].filter((part) => part !== null).join(" — "));
    }
  }
  if (model.verdict !== null) parts.push(model.verdict);
  return parts.filter((part) => part !== "");
}

// Registration is a side effect of importing this module; the import sits
// beside the other receipt blocks' in `session-card-transcript.tsx`.
registerCommandBlock("arc-reaudit", matchesReauditRow, SessionReauditBlock, {
  attribution: "wheel",
  presentation: "entry",
  findParts: reauditFindParts,
});
