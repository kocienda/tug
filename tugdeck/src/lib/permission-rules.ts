/**
 * permission-rules.ts — pure data model + helpers for Claude Code's
 * tool-permission **rules** (`/permissions`), distinct from the permission
 * *mode* ([permission-mode.ts]).
 *
 * A rule is a matcher string (`Bash(ls:*)`, `WebSearch`, `Read(./.env)`) living
 * in one of three writable scopes — user / project / local — each a
 * `permissions: { allow, ask, deny, additionalDirectories }` object in a
 * settings file. tugcast's `/api/permissions` endpoint reads every scope and
 * mutates one rule at a time (see `permission-rules-store.ts`); this module is
 * the pure layer the store and the editor sheet share: parse a matcher, build
 * the scope-labeled union for a bucket, and filter by search query.
 *
 * Scope precedence (Managed > CLI > Local > Project > User) and the merge-not-
 * override semantics are Claude Code's, captured in
 * `dash/transport-exploration.md`. The session card edits the three writable
 * scopes; Managed is admin-only and never surfaced here.
 *
 * Pure: no React, no DOM, no fetch — just types and total functions.
 *
 * @module lib/permission-rules
 */

/** A writable settings scope, in the editor's add-rule selector order. */
export type RuleScope = "user" | "project" | "local";

/** A tool-matcher rule bucket (the `Allow` / `Ask` / `Deny` tabs). */
export type RuleBucket = "allow" | "ask" | "deny";

/** The four `permissions` object keys: the three rule buckets + workspace. */
export type BucketKey = RuleBucket | "additionalDirectories";

/** The rule buckets in tab order. */
export const RULE_BUCKETS: readonly RuleBucket[] = ["allow", "ask", "deny"];

/** All writable scopes, **highest precedence first** (Local > Project > User). */
export const SCOPE_PRECEDENCE: readonly RuleScope[] = ["local", "project", "user"];

/** Human label for a scope, for the editor's scope badge / selector. */
export const SCOPE_LABELS: Record<RuleScope, string> = {
  user: "User",
  project: "Project",
  local: "Local",
};

/** One scope's four rule buckets, exactly the settings file's shape. */
export interface ScopeBuckets {
  allow: string[];
  ask: string[];
  deny: string[];
  additionalDirectories: string[];
}

/**
 * The full rules picture across the three writable scopes plus the session's
 * working directory (the project root the project/local scopes resolve under,
 * shown read-only on the `Workspace` tab).
 */
export interface PermissionsSnapshot {
  cwd: string | null;
  scopes: Record<RuleScope, ScopeBuckets>;
}

/**
 * One rule resolved for display: the verbatim matcher, its parsed tool +
 * specifier (for a two-line row), and the scope it lives in.
 */
export interface ResolvedRule {
  /** The matcher string exactly as stored — the value the endpoint mutates. */
  raw: string;
  /** Tool name, e.g. `Bash`, `WebSearch`, `Read`. */
  tool: string;
  /** Specifier inside the parens, or `null` for a bare tool (`WebSearch`). */
  specifier: string | null;
  /** Which scope's file this rule lives in. */
  scope: RuleScope;
}

/** An all-empty `ScopeBuckets` — the shape for a scope with no rules. */
export function emptyScopeBuckets(): ScopeBuckets {
  return { allow: [], ask: [], deny: [], additionalDirectories: [] };
}

/** An empty snapshot for `cwd` (all three scopes empty). */
export function emptyPermissionsSnapshot(cwd: string | null): PermissionsSnapshot {
  return {
    cwd,
    scopes: {
      user: emptyScopeBuckets(),
      project: emptyScopeBuckets(),
      local: emptyScopeBuckets(),
    },
  };
}

// `Tool(specifier)` or a bare `Tool`. The specifier captures everything inside
// the outermost parens (matchers nest no parens in practice). A string that
// isn't this shape is treated as a bare tool with the whole string as the name.
const RULE_PATTERN = /^([A-Za-z_][\w-]*)\((.*)\)$/;

/**
 * Parse a matcher string into its tool and optional specifier. Total: a string
 * that doesn't match `Tool(...)` is returned as a bare tool (`tool` = the whole
 * trimmed string, `specifier` = null), so display never throws on an odd rule.
 */
export function parseRule(raw: string): { tool: string; specifier: string | null } {
  const trimmed = raw.trim();
  const m = RULE_PATTERN.exec(trimmed);
  if (m === null) {
    return { tool: trimmed, specifier: null };
  }
  return { tool: m[1], specifier: m[2] };
}

// A syntactically well-formed matcher: a `Tool` name (letter/underscore then
// word chars / hyphens) optionally followed by a parenthesized specifier. This
// is a *shape* check, not a known-tool check — Claude Code itself accepts any
// tool name (`Foo`, `qqolWIH…`), so we only reject input that isn't a matcher
// at all (empty, leading digit/space, embedded spaces in the bare name).
const RULE_SYNTAX = /^[A-Za-z_][\w-]*(\(.*\))?$/;

/**
 * Whether `raw` is a syntactically valid permission-rule matcher. Used to gate
 * the add-rule control so blatantly malformed input can't be added; unknown
 * tool names still pass (matching the terminal's permissive entry).
 */
export function isValidRuleMatcher(raw: string): boolean {
  return RULE_SYNTAX.test(raw.trim());
}

/**
 * Derive a starting rule matcher for a denied tool call (the Recently-denied
 * "add to Allow/Ask/Deny" affordance). A `Bash` denial yields the exact command
 * (`Bash(<command>)`); any other tool yields its bare name (matches all uses) —
 * a sensible default the user can narrow in the Allow tab. Decoupled from the
 * store's `PermissionDenial` type so this stays a pure rules helper.
 */
export function denialToMatcher(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  if (
    toolName === "Bash" &&
    typeof toolInput.command === "string" &&
    toolInput.command.trim() !== ""
  ) {
    return `Bash(${toolInput.command.trim()})`;
  }
  return toolName;
}

/**
 * Coerce an unknown JSON value into a `ScopeBuckets`, keeping only string
 * entries in each bucket (defensive against a hand-edited settings file).
 */
function coerceScopeBuckets(value: unknown): ScopeBuckets {
  const out = emptyScopeBuckets();
  if (value === null || typeof value !== "object") return out;
  const obj = value as Record<string, unknown>;
  for (const key of ["allow", "ask", "deny", "additionalDirectories"] as const) {
    const arr = obj[key];
    if (Array.isArray(arr)) {
      out[key] = arr.filter((e): e is string => typeof e === "string");
    }
  }
  return out;
}

/**
 * Parse the `GET /api/permissions` response body into a `PermissionsSnapshot`.
 * Tolerant of a missing scope or bucket (treated as empty) so a malformed or
 * partial response degrades to "no rules" rather than throwing.
 */
export function parsePermissionsResponse(body: unknown): PermissionsSnapshot {
  if (body === null || typeof body !== "object") {
    return emptyPermissionsSnapshot(null);
  }
  const obj = body as Record<string, unknown>;
  const cwd = typeof obj.cwd === "string" ? obj.cwd : null;
  const scopes =
    obj.scopes !== null && typeof obj.scopes === "object"
      ? (obj.scopes as Record<string, unknown>)
      : {};
  return {
    cwd,
    scopes: {
      user: coerceScopeBuckets(scopes.user),
      project: coerceScopeBuckets(scopes.project),
      local: coerceScopeBuckets(scopes.local),
    },
  };
}

/**
 * Build the scope-labeled union of one bucket across all writable scopes.
 *
 * Scopes are visited highest-precedence first (Local → Project → User); a rule
 * present in more than one scope appears once, tagged with the highest-
 * precedence scope it lives in — matching Claude Code's "rules merge, deny wins,
 * higher scope is the effective one" model. Order within the result is scope
 * precedence then in-file order.
 */
export function resolveBucket(
  snapshot: PermissionsSnapshot,
  bucket: BucketKey,
): ResolvedRule[] {
  const seen = new Set<string>();
  const resolved: ResolvedRule[] = [];
  for (const scope of SCOPE_PRECEDENCE) {
    for (const raw of snapshot.scopes[scope][bucket]) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      const { tool, specifier } = parseRule(raw);
      resolved.push({ raw, tool, specifier, scope });
    }
  }
  return resolved;
}

/**
 * Filter resolved rules by a case-insensitive substring match on the raw
 * matcher. An empty / whitespace query returns the input unchanged.
 */
export function filterResolvedRules(
  rules: readonly ResolvedRule[],
  query: string,
): ResolvedRule[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...rules];
  return rules.filter((rule) => rule.raw.toLowerCase().includes(needle));
}
