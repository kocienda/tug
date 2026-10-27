/**
 * `DesignSyncToolBlock` — Layer-2 wrapper for the `DesignSync` tool.
 *
 * `DesignSync` reads and updates a claude.ai design-system project,
 * one component at a time, under the user-started `/design-sync`
 * skill. It dispatches on `method`: the reads (`list_projects`,
 * `get_project`, `list_files`, `get_file`), project setup
 * (`create_project`), the plan boundary (`finalize_plan`), and the
 * writes that need a plan (`write_files`, `delete_files`,
 * `register_assets`, `unregister_assets`), plus `report_validate`.
 * The result is JSON from the API.
 *
 * Composition (Spec S03, [#bk-conformance]):
 *  - `BlockChrome` owns the frame: a composed tool name
 *    (`Design Sync · <method>`), the status stripe, the inline
 *    `SessionCautionBadge`, and the error band.
 *  - **Header** — verb-qualified name; the args slot carries the
 *    most-identifying field: the file `path` for `get_file`, the new
 *    `name` for `create_project`, else the `projectId`.
 *  - **Body** — `method:` row + `project:` / `path:` / `plan:` rows
 *    when present + a count row for each list the call carried
 *    (`writes`, `deletes`, `files`, `paths`, `assets`) + the result
 *    as a tailed `BlockPre`. The lists themselves are not expanded —
 *    a 256-entry plan is the permission prompt's reading, not the
 *    transcript's.
 *  - **Chrome-level fold + copy** — collapsed by default. Copy
 *    collects the result.
 *
 * Streaming / error (Spec S03):
 *  - `status === "streaming"` → body is `null`.
 *  - `status === "error"` → chrome paints the error band; body
 *    still renders the input rows.
 *  - `status === "ready"` → header + body.
 *
 * Laws:
 *  - [L06] no React state for appearance.
 *  - [L19] `data-slot="design-sync-tool-block"`. No paired `.css`.
 *  - [L20] no new tokens.
 *
 * Decisions:
 *  - [D05] two-layer hybrid.
 *  - [D101] visibility policy — `designsync` is bespoke.
 *
 * @module components/tugways/cards/blocks/design-sync-tool-block
 */

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

/** `DesignSync` tool input (from `tool_use.input`), the fields the row reads. */
export interface DesignSyncInput {
  method?: string;
  projectId?: string;
  path?: string;
  planId?: string;
  name?: string;
  localDir?: string;
  /** Entry counts of the list fields, by field name, for the ones present. */
  counts: ReadonlyArray<readonly [field: string, count: number]>;
}

const LIST_FIELDS = ["writes", "deletes", "files", "paths", "assets"] as const;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Narrow the wrapper-side `unknown` input to `DesignSyncInput`.
 * Defensive: a non-object input yields an empty shape; mistyped
 * strings are dropped; a list field counts only when it is an array.
 */
export function narrowDesignSyncInput(value: unknown): DesignSyncInput {
  if (value === null || typeof value !== "object") return { counts: [] };
  const v = value as Record<string, unknown>;
  const counts: Array<readonly [string, number]> = [];
  for (const field of LIST_FIELDS) {
    const list = v[field];
    if (Array.isArray(list)) counts.push([field, list.length]);
  }
  return {
    method: optionalString(v.method),
    projectId: optionalString(v.projectId),
    path: optionalString(v.path),
    planId: optionalString(v.planId),
    name: optionalString(v.name),
    localDir: optionalString(v.localDir),
    counts,
  };
}

// ---------------------------------------------------------------------------
// Header composition
// ---------------------------------------------------------------------------

/** `Design Sync · <method>` when a method is present, else `Design Sync`. */
export function composeDesignSyncToolName(method: string | undefined): string {
  if (method === undefined) return "Design Sync";
  return `Design Sync · ${method}`;
}

/**
 * The header's target — the file path for a file read, the new
 * project's name for `create_project`, else the project id.
 */
export function composeDesignSyncTarget(
  input: DesignSyncInput,
): string | undefined {
  return input.path ?? input.name ?? input.projectId;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const DesignSyncToolBlock: React.FC<ToolBlockProps> = ({
  input,
  textOutput,
  status,
  phase,
  caution,
}) => {
  const syncInput = React.useMemo(() => narrowDesignSyncInput(input), [input]);
  const composedToolName = composeDesignSyncToolName(syncInput.method);
  const target = composeDesignSyncTarget(syncInput);

  const argsSummary =
    target !== undefined ? (
      <TugTooltip content={target} side="bottom" truncated>
        <code
          data-slot="design-sync-tool-block-target"
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
    body = renderDesignSyncBody({ input: syncInput, textOutput });
  }

  const copyText =
    textOutput !== undefined && textOutput.length > 0 ? textOutput : undefined;

  return (
    <BlockChrome
      rootSlot="design-sync-tool-block"
      toolName={composedToolName}
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
  input: DesignSyncInput;
  textOutput: string | undefined;
}

function renderDesignSyncBody({
  input,
  textOutput,
}: RenderBodyArgs): React.ReactNode {
  const hasResult = textOutput !== undefined && textOutput.length > 0;
  if (
    input.method === undefined &&
    input.projectId === undefined &&
    input.path === undefined &&
    input.planId === undefined &&
    input.name === undefined &&
    input.localDir === undefined &&
    input.counts.length === 0 &&
    !hasResult
  ) {
    return null;
  }
  return (
    <BlockBody>
      {input.method !== undefined ? (
        <BlockFieldRow label="method">
          <code>{input.method}</code>
        </BlockFieldRow>
      ) : null}
      {input.projectId !== undefined ? (
        <BlockFieldRow label="project">
          <code>{input.projectId}</code>
        </BlockFieldRow>
      ) : null}
      {input.name !== undefined ? (
        <BlockFieldRow label="name">
          <code>{input.name}</code>
        </BlockFieldRow>
      ) : null}
      {input.path !== undefined ? (
        <BlockFieldRow label="path">
          <code>{input.path}</code>
        </BlockFieldRow>
      ) : null}
      {input.planId !== undefined ? (
        <BlockFieldRow label="plan">
          <code>{input.planId}</code>
        </BlockFieldRow>
      ) : null}
      {input.localDir !== undefined ? (
        <BlockFieldRow label="local dir">
          <code>{input.localDir}</code>
        </BlockFieldRow>
      ) : null}
      {input.counts.map(([field, count]) => (
        <BlockFieldRow key={field} label={field}>
          <code>{`${count} ${count === 1 ? "entry" : "entries"}`}</code>
        </BlockFieldRow>
      ))}
      {hasResult ? (
        <BlockFieldRow label="result" layout="stacked">
          <BlockPre>{textOutput}</BlockPre>
        </BlockFieldRow>
      ) : null}
    </BlockBody>
  );
}
