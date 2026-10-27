/**
 * `WorkflowToolBlock` — Layer-2 wrapper for the `Workflow` tool.
 *
 * `Workflow` runs a script that orchestrates subagents deterministically.
 * The call returns at once with a run id, the run proceeds in the
 * background, and a task notification closes it later — so the row's
 * job is to say *which* workflow was launched and what it was given,
 * not to narrate the run. The script opens with a `meta` literal
 * (`name`, `description`, `phases`), and that name is the header's
 * target; the input alternatively names a saved workflow (`name`) or a
 * script on disk (`scriptPath`), and may resume a prior run
 * (`resumeFromRunId`).
 *
 * Composition (Spec S03, [#bk-conformance]):
 *  - `BlockChrome` owns the frame: the tool name, the status stripe,
 *    the inline `SessionCautionBadge`, and the error band.
 *  - **Header** — the name; the args slot carries the workflow's name
 *    (from the script's `meta`, else the saved name, else the script
 *    path's basename).
 *  - **Body** — `name:` row + `description:` row (from `meta`) +
 *    `resume:` row when resuming + `args:` (stacked JSON) + `script:`
 *    (stacked `BlockPre`) or `script path:` + the result (stacked
 *    `BlockPre`, the run id and the final value).
 *  - **Chrome-level fold + copy** — collapsed by default; the header
 *    names the workflow. Copy collects the result.
 *
 * Streaming / error (Spec S03):
 *  - `status === "streaming"` → body is `null`.
 *  - `status === "error"` → chrome paints the error band; body
 *    still renders the input rows.
 *  - `status === "ready"` → header + body.
 *
 * Laws:
 *  - [L06] no React state for appearance.
 *  - [L19] `data-slot="workflow-tool-block"`. No paired `.css`.
 *  - [L20] no new tokens.
 *
 * Decisions:
 *  - [D05] two-layer hybrid.
 *  - [D101] visibility policy — `workflow` is bespoke.
 *
 * @module components/tugways/cards/blocks/workflow-tool-block
 */

import React from "react";

import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { basename } from "@/lib/display-path";

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

/** `Workflow` tool input (from `tool_use.input`). */
export interface WorkflowInput {
  /** Inline workflow script. */
  script?: string;
  /** Path to a workflow script on disk. */
  scriptPath?: string;
  /** A predefined workflow's name. */
  name?: string;
  /** Run id of a prior invocation to resume from. */
  resumeFromRunId?: string;
  /** Input exposed to the script as `args`, verbatim. */
  args?: unknown;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Narrow the wrapper-side `unknown` input to `WorkflowInput`.
 * Defensive: returns `{}` for non-object inputs and drops mistyped
 * string fields; `args` is kept as given (it is the script's own
 * input and has no shape of ours).
 */
export function narrowWorkflowInput(value: unknown): WorkflowInput {
  if (value === null || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  return {
    script: optionalString(v.script),
    scriptPath: optionalString(v.scriptPath),
    name: optionalString(v.name),
    resumeFromRunId: optionalString(v.resumeFromRunId),
    args: v.args,
  };
}

// ---------------------------------------------------------------------------
// Meta reading
// ---------------------------------------------------------------------------

/** The `name` and `description` a script's `meta` literal declares. */
export interface WorkflowMeta {
  name?: string;
  description?: string;
}

/**
 * Read `name` and `description` out of the script's leading
 * `export const meta = { … }` literal. The literal is required to be
 * pure (no interpolation), so a single-quoted, double-quoted or
 * backticked string after the key is the whole value. Reads only the
 * first occurrence of each key inside the meta block; returns `{}`
 * when there is no meta block or the key is absent.
 */
export function readWorkflowMeta(script: string | undefined): WorkflowMeta {
  if (script === undefined) return {};
  const start = script.search(/export\s+const\s+meta\s*=\s*\{/);
  if (start < 0) return {};
  // The meta block ends at the first `}` that closes the top-level
  // brace; phases hold nested braces, so count depth.
  let depth = 0;
  let end = -1;
  for (let i = script.indexOf("{", start); i < script.length; i += 1) {
    const ch = script[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = end < 0 ? script.slice(start) : script.slice(start, end + 1);
  const read = (key: string): string | undefined => {
    const m = new RegExp(`\\b${key}\\s*:\\s*(?:'([^']*)'|"([^"]*)"|\`([^\`]*)\`)`).exec(
      block,
    );
    if (m === null) return undefined;
    const value = m[1] ?? m[2] ?? m[3];
    return value !== undefined && value.length > 0 ? value : undefined;
  };
  return { name: read("name"), description: read("description") };
}

// ---------------------------------------------------------------------------
// Header composition
// ---------------------------------------------------------------------------

/**
 * The header's target — the workflow's name from the script's `meta`,
 * else the saved workflow's name, else the script path's basename.
 * `undefined` when the input carries none of them.
 */
export function composeWorkflowTarget(
  input: WorkflowInput,
  meta: WorkflowMeta,
): string | undefined {
  if (meta.name !== undefined) return meta.name;
  if (input.name !== undefined) return input.name;
  if (input.scriptPath !== undefined) return basename(input.scriptPath);
  return undefined;
}

/** JSON for the `args:` row; `String(value)` if it cannot serialize. */
export function formatWorkflowArgs(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const WorkflowToolBlock: React.FC<ToolBlockProps> = ({
  input,
  textOutput,
  status,
  phase,
  caution,
}) => {
  const workflowInput = React.useMemo(() => narrowWorkflowInput(input), [input]);
  const meta = React.useMemo(
    () => readWorkflowMeta(workflowInput.script),
    [workflowInput.script],
  );
  const target = composeWorkflowTarget(workflowInput, meta);

  const argsSummary =
    target !== undefined ? (
      <TugTooltip content={target} side="bottom" truncated>
        <code
          data-slot="workflow-tool-block-target"
          data-tugx-findable=""
          className="tool-call-header-clamp"
        >
          {target}
        </code>
      </TugTooltip>
    ) : undefined;

  let body: React.ReactNode;
  if (status === "streaming") {
    body = null;
  } else {
    body = renderWorkflowBody({ input: workflowInput, meta, textOutput });
  }

  const copyText =
    textOutput !== undefined && textOutput.length > 0 ? textOutput : undefined;

  return (
    <BlockChrome
      rootSlot="workflow-tool-block"
      toolName="Workflow"
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
  input: WorkflowInput;
  meta: WorkflowMeta;
  textOutput: string | undefined;
}

function renderWorkflowBody({
  input,
  meta,
  textOutput,
}: RenderBodyArgs): React.ReactNode {
  const name = meta.name ?? input.name;
  const hasArgs = input.args !== undefined;
  const hasResult = textOutput !== undefined && textOutput.length > 0;
  if (
    name === undefined &&
    meta.description === undefined &&
    input.resumeFromRunId === undefined &&
    !hasArgs &&
    input.script === undefined &&
    input.scriptPath === undefined &&
    !hasResult
  ) {
    return null;
  }
  return (
    <BlockBody>
      {name !== undefined ? (
        <BlockFieldRow label="name">
          <code>{name}</code>
        </BlockFieldRow>
      ) : null}
      {meta.description !== undefined ? (
        <BlockFieldRow label="description">
          <span>{meta.description}</span>
        </BlockFieldRow>
      ) : null}
      {input.resumeFromRunId !== undefined ? (
        <BlockFieldRow label="resume">
          <code>{input.resumeFromRunId}</code>
        </BlockFieldRow>
      ) : null}
      {input.scriptPath !== undefined ? (
        <BlockFieldRow label="script path">
          <code>{input.scriptPath}</code>
        </BlockFieldRow>
      ) : null}
      {hasArgs ? (
        <BlockFieldRow label="args" layout="stacked">
          <BlockPre>{formatWorkflowArgs(input.args)}</BlockPre>
        </BlockFieldRow>
      ) : null}
      {input.script !== undefined ? (
        <BlockFieldRow label="script" layout="stacked">
          <BlockPre>{input.script}</BlockPre>
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
