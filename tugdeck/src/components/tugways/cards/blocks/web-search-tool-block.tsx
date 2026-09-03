/**
 * `WebSearchToolBlock` — Layer-2 wrapper for the `WebSearch` tool.
 *
 * `WebSearch` takes `{ query, allowed_domains?, blocked_domains? }`
 * and returns a list of search results — each typically with a title,
 * URL, and short snippet. The tool's response shape is markdown-formatted
 * text (Claude Code emits search results as markdown hyperlinks +
 * descriptions), so the wrapper parses that text into structured per-
 * result rows and renders them as a list of `TugLink` + snippet pairs.
 * When the text shape doesn't match the expected per-result form, the
 * wrapper degrades gracefully to a `TugMarkdownBlock` render of the
 * raw result.
 *
 * Composition (per [Spec S03] / [Table T02] / [#bk-conformance]):
 *
 *  - **Header** — a `Search` icon + `WebSearch` + the query in the
 *    args slot. The query ellipsizes from the end via the chrome's
 *    args-summary CSS (it's command-shaped, not a path — middle-
 *    ellipsis would be the wrong pattern). A `{N} results` count
 *    badge surfaces when the parser recognised at least one result.
 *
 *  - **Body** — when the parser yields one or more results, a flat
 *    list of `TugLink` (title → URL) + snippet rows. When no
 *    structured results parse out, the raw text falls back to
 *    `TugMarkdownBlock` so the user still sees Claude Code's
 *    markdown rendition of the result.
 *
 *  - **Chrome-level fold + copy** — default OPEN. The result list IS
 *    the answer; folded by default would hide it. Copy collects the
 *    raw result text so a teammate can paste it elsewhere with
 *    formatting intact.
 *
 * Streaming / error ([Spec S03]):
 *
 *  - `status === "streaming"` → header still shows whatever input
 *    fragment has arrived; body is `null` (the header dot is the in-flight signal).
 *  - `status === "error"` → chrome paints the error band from the
 *    plain-text `tool_result.output`; body is dropped so the failure
 *    reads as the primary content.
 *  - `status === "ready"` → steady-state list render.
 *
 * Wire shape (`input` and `textOutput`):
 *
 *  - `input`: `{ query: string, allowed_domains?: string[],
 *    blocked_domains?: string[] }`. Only the query rides the header
 *    today; the domain filters are diagnostic and surface as body
 *    field rows when present.
 *  - `textOutput`: markdown-formatted result text. Parsed by
 *    `parseSearchResults` into `WebSearchResultEntry[]`; the parser
 *    recognises the canonical `[Title](URL) — snippet` per-line shape
 *    and a few common Claude Code variants. Unparseable text falls
 *    through to a raw markdown render.
 *
 * Laws:
 *  - [L06] no React state for appearance; chrome owns DOM
 *    attributes; body composition is pure props.
 *  - [L19] file pair (`.tsx` + `.css`),
 *    `data-slot="web-search-tool-block"` (delegated to chrome via
 *    `rootSlot`).
 *  - [L20] reuses the chrome's `--tugx-block-*`,
 *    `TugMarkdownBlock`'s `--tugx-md-*`, and `TugLink`'s `--tugx-link-*`.
 *    The result-count badge rides the chrome's caution-badge metrics.
 *
 * Decisions:
 *  - [D05] two-layer hybrid — wrapper owns chrome + result parsing;
 *    `TugLink` / `TugMarkdownBlock` own link / markdown rendering.
 *  - [D101] visibility policy — `websearch` moves from `default-intent`
 *    to bespoke in this change; the policy entry is removed in the
 *    same commit.
 *
 * @module components/tugways/cards/blocks/web-search-tool-block
 */

import "./web-search-tool-block.css";

import React from "react";
import { List } from "lucide-react";

import { TugBadge } from "@/components/tugways/tug-badge";
import { TugLink } from "@/components/tugways/tug-link";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import { TugTooltip } from "@/components/tugways/tug-tooltip";

import { BlockBody, BlockFieldRow } from "../../blocks/block-bits";
import { BlockChrome } from "../../blocks/block-chrome";
import type { ToolBlockProps } from "../../blocks/types";

// ---------------------------------------------------------------------------
// Wire-shape narrowings
// ---------------------------------------------------------------------------

/** `WebSearch` tool input — the wire fields under `tool_use.input`. */
export interface WebSearchInput {
  query?: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

/** One parsed search result — title + URL + optional snippet. */
export interface WebSearchResultEntry {
  title: string;
  url: string;
  snippet?: string;
}

function narrowStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Narrow the wrapper-side `unknown` input. Defensive: returns `{}`
 * for non-object inputs, drops mistyped fields silently, drops
 * non-string entries from the domain filter arrays.
 */
export function narrowWebSearchInput(value: unknown): WebSearchInput {
  if (value === null || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  return {
    query: typeof v.query === "string" ? v.query : undefined,
    allowed_domains: narrowStringArray(v.allowed_domains),
    blocked_domains: narrowStringArray(v.blocked_domains),
  };
}

// ---------------------------------------------------------------------------
// Search-result parsing
//
// Claude Code's WebSearch tool returns search results as markdown text.
// The dominant shape is one result per line / paragraph as:
//
//   - [Title](https://example.com/path) — short snippet
//
// or
//
//   1. [Title](https://example.com/path)
//      short snippet
//
// The parser walks the lines looking for `[text](url)` markdown links
// and pairs each link with the trailing snippet on the same line (after
// a separator like ` — ` or ` - `) OR the lines immediately following
// it (until the next link). Lines with no link and no current link to
// attach to are skipped.
//
// Pure and exported for tests.
// ---------------------------------------------------------------------------

/**
 * Markdown link pattern — captures `[text](url)`. Tolerant of trailing
 * punctuation in the link text; the URL stops at the first whitespace,
 * unescaped closing paren, or end of string.
 */
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;

/**
 * Strip a leading list marker (`- `, `* `, `1. `, `1) `) from a line so
 * the link parser can match flush against the link.
 */
function stripListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
}

/**
 * Trim a snippet-fragment string: collapses runs of whitespace, drops
 * common separator arcs at the head, drops empty results.
 */
function trimSnippet(text: string): string {
  return text
    .replace(/^\s*[—–-]+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a markdown-formatted search-result text into entries. Returns
 * an empty array when no link pattern matches anywhere in the text.
 */
export function parseSearchResults(
  textOutput: string | undefined,
): WebSearchResultEntry[] {
  if (textOutput === undefined || textOutput.length === 0) return [];

  const entries: WebSearchResultEntry[] = [];
  const lines = textOutput.split(/\r?\n/);
  // The most-recently-emitted entry — trailing snippet lines append
  // to its `snippet` until the next link starts a new entry.
  let active: WebSearchResultEntry | null = null;

  for (const rawLine of lines) {
    const stripped = stripListMarker(rawLine);
    const match = MARKDOWN_LINK_PATTERN.exec(stripped);
    if (match !== null) {
      const title = match[1].trim();
      const url = match[2];
      // Anything after the link on the same line is the inline snippet
      // (the canonical `— snippet` shape). Anything before is title-
      // adjacent prose — ignored.
      const afterIdx = stripped.indexOf(match[0]) + match[0].length;
      const inlineTail = trimSnippet(stripped.slice(afterIdx));
      active = {
        title,
        url,
        snippet: inlineTail.length > 0 ? inlineTail : undefined,
      };
      entries.push(active);
      continue;
    }

    if (active === null) continue;
    const text = trimSnippet(stripped);
    if (text.length === 0) continue;
    // Skip lines that look like a non-link list item — they're a
    // sibling entry whose link the parser didn't recognise, not a
    // continuation snippet for the previous result.
    if (/^\s*(?:[-*+]|\d+[.)])\s/.test(rawLine)) continue;
    active.snippet =
      active.snippet === undefined ? text : `${active.snippet} ${text}`;
  }

  return entries;
}

/**
 * Compose the header result-count label, e.g. "12 results" / "1 result".
 * Returns `undefined` when count is zero (the header reads as just
 * `WebSearch · {query}` until results land).
 */
export function composeResultCountLabel(count: number): string | undefined {
  if (count <= 0) return undefined;
  return `${count.toLocaleString()} ${count === 1 ? "result" : "results"}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const WebSearchToolBlock: React.FC<ToolBlockProps> = ({
  toolUseId,
  toolName,
  input,
  textOutput,
  status,
  phase,
  caution,
}) => {
  const searchInput = React.useMemo(
    () => narrowWebSearchInput(input),
    [input],
  );
  const results = React.useMemo(
    () => parseSearchResults(textOutput),
    [textOutput],
  );
  const countLabel = React.useMemo(
    () => composeResultCountLabel(results.length),
    [results.length],
  );

  const query = searchInput.query;
  const argsSummary =
    query !== undefined ? (
      <span className="web-search-tool-block-args">
        <TugTooltip content={query} side="bottom" truncated>
          <code
            data-slot="web-search-tool-block-query"
            data-tugx-findable=""
            className="tool-call-header-clamp"
          >
            {query}
          </code>
        </TugTooltip>
        {countLabel !== undefined ? (
          <TugBadge
            data-slot="web-search-tool-block-count"
            emphasis="ghost"
            role="action"
            size="md"
            icon={<List size={12} aria-hidden="true" />}
          >
            {countLabel}
          </TugBadge>
        ) : null}
      </span>
    ) : undefined;

  const allowedDomains = searchInput.allowed_domains;
  const blockedDomains = searchInput.blocked_domains;
  const hasResults = results.length > 0;
  const hasRawText = textOutput !== undefined && textOutput.length > 0;

  let body: React.ReactNode;
  if (status === "streaming") {
    body = null;
  } else if (status === "error") {
    body = null;
  } else if (hasResults || hasRawText || allowedDomains !== undefined || blockedDomains !== undefined) {
    body = (
      <BlockBody>
        {allowedDomains !== undefined ? (
          <BlockFieldRow label="allowed_domains">
            <code>{allowedDomains.join(", ")}</code>
          </BlockFieldRow>
        ) : null}
        {blockedDomains !== undefined ? (
          <BlockFieldRow label="blocked_domains">
            <code>{blockedDomains.join(", ")}</code>
          </BlockFieldRow>
        ) : null}
        {hasResults ? (
          <ol
            className="web-search-tool-block-results"
            data-slot="web-search-tool-block-results"
          >
            {results.map((entry, idx) => (
              <li
                key={`${idx}-${entry.url}`}
                className="web-search-tool-block-result"
                data-slot="web-search-tool-block-result"
              >
                <TugLink href={entry.url} external>
                  {entry.title}
                </TugLink>
                <span
                  className="web-search-tool-block-result-url"
                  data-slot="web-search-tool-block-result-url"
                >
                  {entry.url}
                </span>
                {entry.snippet !== undefined ? (
                  <p
                    className="web-search-tool-block-result-snippet"
                    data-slot="web-search-tool-block-result-snippet"
                  >
                    {entry.snippet}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : hasRawText ? (
          <TugMarkdownBlock
            initialText={textOutput}
            className="web-search-tool-block-markdown"
            key={toolUseId}
          />
        ) : null}
      </BlockBody>
    );
  } else {
    body = null;
  }

  const copyText =
    textOutput !== undefined && textOutput.length > 0 ? textOutput : undefined;

  return (
    <BlockChrome
      rootSlot="web-search-tool-block"
      toolName={toolName}
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
