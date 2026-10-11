/**
 * gallery-tug-inline-dialog.tsx — concrete usages of `TugInlineDialog`
 * for the Component Gallery.
 *
 * One card, two sections — each a real consumer of `TugInlineDialog`
 * mounted against a minimal `CodeSessionStore` double. Tuning the
 * primitive's tokens or layout immediately reflects in both sections
 * so changes can be evaluated against the two callsites we actually
 * ship.
 *
 *   1. PermissionDialog — a spread of Bash commands (one-liner with a
 *      scope-picker radio stack, two-line wrap, and two long commands that
 *      trip the `TugClamp` cap) to vet the body margin model and the
 *      8-line clamp. Each mock store implements `subscribe` /
 *      `getSnapshot.pendingApproval` / `respondApproval`.
 *   2. QuestionDialog — 4-question wizard (the "calculator" walkthrough),
 *      single-select with auto-advance. Mock store implements
 *      `subscribe` / `getSnapshot.pendingQuestion` / `respondQuestion`
 *      / `popInteractive`.
 *
 * Each section has a Reset button beneath the dialog that re-arms the
 * pending request, so multiple Allow / Deny / Submit / Cancel
 * round-trips can be exercised in the same session.
 *
 * @module components/tugways/cards/gallery-tug-inline-dialog
 */

import React from "react";

import { PermissionDialog } from "@/components/tugways/chrome/session-permission-dialog";
import { QuestionDialog } from "@/components/tugways/chrome/session-question-dialog";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { Subscribable } from "@/lib/subscribable";
import type {
  CodeSessionStore,
  ControlRequestForward,
} from "@/lib/code-session-store";

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
// Mock CodeSessionStore — minimal surface for PermissionDialog
// ---------------------------------------------------------------------------

interface PermissionSnapshot {
  pendingApproval: ControlRequestForward | null;
}

class MockPermissionStore extends Subscribable {
  private _pending: ControlRequestForward | null;
  // Cache the snapshot object so a useSyncExternalStore selector
  // doesn't see a fresh reference on every call (would loop).
  private _snapshot: PermissionSnapshot;

  constructor(initial: ControlRequestForward) {
    super();
    this._pending = initial;
    this._snapshot = { pendingApproval: initial };
  }

  getSnapshot = (): PermissionSnapshot => this._snapshot;

  respondApproval = (
    requestId: string,
    _payload: { decision: "allow" | "deny"; message?: string },
  ): void => {
    if (this._pending?.request_id === requestId) {
      this._pending = null;
      this._snapshot = { pendingApproval: null };
      this.notify();
    }
  };

  arm(request: ControlRequestForward): void {
    this._pending = request;
    this._snapshot = { pendingApproval: request };
    this.notify();
  }
}

const TOKEI_SUGGESTIONS: ControlRequestForward["permission_suggestions"] = [
  {
    behavior: "allow",
    destination: "project",
    rules: [{ ruleContent: "Bash(tokei)", toolName: "Bash" }],
    type: "addRule",
  },
];

// A spread of command lengths to vet the body margin model + the TugClamp
// 8-line cap: one-liner (no clamp), a two-line wrap (no clamp), a compound
// command that just trips the cap, and a very long one well past it.
const CMD_ONE_LINER = "tokei";
const CMD_TWO_LINE =
  'for i in 1 2 3 4 5; do echo "tick $i"; sleep 1; done; echo "done"';
const CMD_LONG =
  'cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck/src/components/tugways/cards && ls blocks/ && echo "---DISPATCH HEAD---" && sed -n \'1,60p\' cards/session-assistant-renderer-dispatch.ts 2>/dev/null || find . -name "session-assistant-renderer-dispatch.ts"';
const CMD_VERY_LONG = `${CMD_LONG} && grep -rn "KIND_RENDERERS" . --include="*.ts" | head -40 && echo "scanning the dispatch table for permission renderers" && for f in blocks/*.tsx; do echo "checking $f for a bespoke renderer"; done && echo "sweep complete — every command path accounted for"`;

// ---------------------------------------------------------------------------
// PermissionDemo — one real PermissionDialog on its own mock store
// ---------------------------------------------------------------------------

/**
 * Mounts the real `PermissionDialog` for a given Bash command on a fresh
 * `MockPermissionStore`, echoes the decision, and offers a Reset. Used to
 * stamp out a variety of command lengths in the gallery so the body margin
 * model and the `TugClamp` cap can be eyeballed side by side.
 */
function PermissionDemo({
  requestId,
  command,
  suggestions,
  note,
}: {
  requestId: string;
  command: string;
  suggestions?: ControlRequestForward["permission_suggestions"];
  note: React.ReactNode;
}): React.ReactElement {
  const request = React.useMemo<ControlRequestForward>(
    () => ({
      request_id: requestId,
      is_question: false,
      tool_name: "Bash",
      input: { command },
      permission_suggestions: suggestions,
    }),
    [requestId, command, suggestions],
  );
  const store = React.useMemo(() => new MockPermissionStore(request), [request]);
  const [result, setResult] = React.useState<string>("(pending)");

  React.useEffect(() => {
    const original = store.respondApproval;
    store.respondApproval = (id, payload) => {
      original(id, payload);
      setResult(
        payload.decision === "allow"
          ? `Allowed${payload.message !== undefined ? ` — scope: ${payload.message}` : ""}`
          : "Denied",
      );
    };
    return () => {
      store.respondApproval = original;
    };
  }, [store]);

  const handleReset = React.useCallback(() => {
    store.arm(request);
    setResult("(pending)");
  }, [store, request]);

  return (
    <div style={{ marginBottom: "1.25rem" }}>
      <div style={labelStyle}>{note}</div>
      <PermissionDialog
        input={{ kind: "permission", request }}
        context={{ session: store as unknown as CodeSessionStore }}
      />
      <div style={resultStyle}>
        Result: <strong>{result}</strong>
      </div>
      <div style={{ marginTop: "0.5rem" }}>
        <TugPushButton
          emphasis="outlined"
          role="action"
          size="xs"
          onClick={handleReset}
        >
          Reset request
        </TugPushButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mock CodeSessionStore — minimal surface for QuestionDialog
// ---------------------------------------------------------------------------

interface QuestionSnapshot {
  pendingQuestion: ControlRequestForward | null;
}

class MockQuestionStore extends Subscribable {
  private _pending: ControlRequestForward | null;
  private _snapshot: QuestionSnapshot;

  constructor(initial: ControlRequestForward) {
    super();
    this._pending = initial;
    this._snapshot = { pendingQuestion: initial };
  }

  getSnapshot = (): QuestionSnapshot => this._snapshot;

  respondQuestion = (
    requestId: string,
    _payload: { answers: Record<string, unknown> },
  ): void => {
    if (this._pending?.request_id === requestId) {
      this._clear();
    }
  };

  popInteractive = (): void => {
    this._clear();
  };

  arm(request: ControlRequestForward): void {
    this._pending = request;
    this._snapshot = { pendingQuestion: request };
    this.notify();
  }

  private _clear(): void {
    this._pending = null;
    this._snapshot = { pendingQuestion: null };
    this.notify();
  }
}

// Mirrors the user's "calculator" walkthrough — 4 single-select
// questions, varied option lists, sensible recommended defaults.
const LIVE_CALCULATOR_REQUEST: ControlRequestForward = {
  request_id: "gallery-tug-inline-dialog:calculator",
  is_question: true,
  tool_name: "AskUserQuestion",
  input: {
    questions: [
      {
        question: "How should the calculator accept input?",
        multiSelect: false,
        options: [
          {
            label: "Interactive REPL",
            description:
              "Prompt the user in a loop, read one expression per line until they quit",
          },
          {
            label: "Command-line args",
            description:
              "Read the expression from argv, e.g. `calc 2 + 3`, then exit",
          },
          {
            label: "Both modes",
            description: "Use argv if provided, otherwise fall back to a REPL",
          },
        ],
      },
      {
        question: "Which operations should it support?",
        multiSelect: false,
        options: [
          { label: "Basic four", description: "+ − × ÷" },
          { label: "Basic four plus modulo", description: "+ − × ÷ %" },
          {
            label: "Scientific",
            description: "+ − × ÷ % plus sin/cos/tan, log, exp, etc.",
          },
        ],
      },
      {
        question: "What number type should it use?",
        multiSelect: false,
        options: [
          { label: "double", description: "IEEE-754 64-bit floating point" },
          {
            label: "long double",
            description: "Wider float, platform-dependent precision",
          },
          {
            label: "GMP arbitrary precision",
            description: "Big numbers; linked against libgmp",
          },
        ],
      },
      {
        question: "How polished should error handling be?",
        multiSelect: false,
        options: [
          {
            label: "Minimal",
            description: "Print errno-style messages, exit non-zero",
          },
          {
            label: "Friendly",
            description: "Catch parse errors, print a hint with caret",
          },
          {
            label: "Full",
            description:
              "Friendly errors + suggestions; retry the prompt in REPL mode",
          },
        ],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// GalleryTugInlineDialog
// ---------------------------------------------------------------------------

export function GalleryTugInlineDialog(): React.ReactElement {
  const [questionResult, setQuestionResult] =
    React.useState<string>("(pending)");

  const questionStore = React.useMemo(
    () => new MockQuestionStore(LIVE_CALCULATOR_REQUEST),
    [],
  );

  // Wrap respondQuestion + popInteractive on the QuestionDialog store
  // similarly.
  React.useEffect(() => {
    const originalRespond = questionStore.respondQuestion;
    const originalPop = questionStore.popInteractive;
    questionStore.respondQuestion = (requestId, payload) => {
      originalRespond(requestId, payload);
      const summary = Object.entries(payload.answers)
        .map(([q, a]) => `${q.slice(0, 30)}… → ${String(a)}`)
        .join("\n");
      setQuestionResult(`Submitted:\n${summary}`);
    };
    questionStore.popInteractive = () => {
      originalPop();
      setQuestionResult("Cancelled");
    };
    return () => {
      questionStore.respondQuestion = originalRespond;
      questionStore.popInteractive = originalPop;
    };
  }, [questionStore]);

  const handleResetQuestion = React.useCallback(() => {
    questionStore.arm(LIVE_CALCULATOR_REQUEST);
    setQuestionResult("(pending)");
  }, [questionStore]);

  return (
    <div className="cg-content" data-testid="gallery-tug-inline-dialog">
      {/* ---- 1. PermissionDialog — command-length spread ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">PermissionDialog</TugLabel>
        <div style={labelStyle}>
          The real <code>PermissionDialog</code> mounted on mock{" "}
          <code>CodeSessionStore</code>s — a spread of command lengths to vet
          two things: the body sits in a column inset under the title (the
          icon-column margin model, equal margin each side), and a long
          command caps at 8 lines behind the <code>TugClamp</code> reveal.
        </div>
        <PermissionDemo
          requestId="gallery-perm:tokei"
          command={CMD_ONE_LINER}
          suggestions={TOKEI_SUGGESTIONS}
          note={
            <>
              One-liner with a scope picker (<code>options</code>) — no clamp.
            </>
          }
        />
        <PermissionDemo
          requestId="gallery-perm:loop"
          command={CMD_TWO_LINE}
          note={<>Two-line wrap — fills the inset column, still no clamp.</>}
        />
        <PermissionDemo
          requestId="gallery-perm:long"
          command={CMD_LONG}
          note={<>Compound command that trips the 8-line cap — clamped.</>}
        />
        <PermissionDemo
          requestId="gallery-perm:very-long"
          command={CMD_VERY_LONG}
          note={<>Well past the cap — clamped with the fade + "Show more".</>}
        />
      </div>

      <TugSeparator />

      {/* ---- 2. QuestionDialog ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">QuestionDialog</TugLabel>
        <div style={labelStyle}>
          The real <code>QuestionDialog</code> mounted on a mock{" "}
          <code>CodeSessionStore</code>. Info iconRole; question
          accordion in the body slot; wizard nav (Back / Next) above the
          accordion; <code>Cancel</code> / <code>Submit</code> in
          trailing <code>actions</code>.
        </div>
        <QuestionDialog
          input={{ kind: "question", request: LIVE_CALCULATOR_REQUEST }}
          context={{
            session: questionStore as unknown as CodeSessionStore,
          }}
        />
        <div style={{ ...resultStyle, whiteSpace: "pre-wrap" }}>
          Result: <strong>{questionResult}</strong>
        </div>
        <div style={{ marginTop: "0.5rem" }}>
          <TugPushButton
            emphasis="outlined"
            role="action"
            size="xs"
            onClick={handleResetQuestion}
          >
            Reset request
          </TugPushButton>
        </div>
      </div>
    </div>
  );
}
