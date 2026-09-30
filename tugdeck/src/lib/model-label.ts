/**
 * model-label.ts — THE single source of a model's display label.
 *
 * Every chip that names a model — the Session card's Z4B model chip AND the
 * Settings Assistant default chip — derives its content through
 * {@link resolveModelLabel} in this module. One copy, by construction: the
 * two surfaces cannot drift because there is no second label path.
 *
 * The label is a compact "name with version" — `Opus 4.8 · 1M`,
 * `Fable 5`, `Sonnet 4.6` — derived from live data in this order:
 *
 *  1. A capability/catalog row for the model ({@link modelRowTitle}): the
 *     leading segment of claude's own `description` ("Fable 5 · Most
 *     capable…" → "Fable 5"), with the verbose context phrase compressed
 *     ("Opus 4.8 with 1M context" → "Opus 4.8 · 1M"). This is claude's
 *     reported wording, never a hardcoded list.
 *  2. No row → parse the exact model id ({@link formatModelLabel}):
 *     `claude-opus-4-8[1m]` → `Opus 4.8 · 1M`.
 *  3. Nothing known → `null` (callers show an honest `?` / `Default`).
 *
 * Pure — no React, no DOM, no I/O — so the mapping is unit-testable on its
 * own, mirroring `model-context-max.ts`.
 *
 * Shape of a model id (modern Anthropic convention, family-first):
 *   `claude-<family>-<major>-<minor>[-<release-date>][\[1m\]]`
 *   e.g. `claude-opus-4-8`, `claude-sonnet-4-6`,
 *        `claude-haiku-4-5-20251001`, `claude-opus-4-8[1m]`.
 *
 * The `[1m]` suffix marks the 1M extended-context variant (see
 * `model-context-max.ts`); we surface it as a ` · 1M` annotation.
 *
 * Pure-functional: no DOM, no React, no module-mutable state.
 *
 * @module lib/model-label
 */

import type { CapabilityModel } from "./session-metadata-store";
import { canonicalModelKey, isKeyPrefix } from "./model-selector";

/** The vendor prefix every Claude model id carries. */
const CLAUDE_PREFIX = "claude-";

/** The extended-context suffix and the annotation it surfaces as. */
const EXTENDED_SUFFIX = "[1m]";
const EXTENDED_LABEL = "1M";

/**
 * Format a Claude model id for display.
 *
 *  - `claude-opus-4-8[1m]`        → `Opus 4.8 · 1M`
 *  - `claude-sonnet-4-6`          → `Sonnet 4.6`
 *  - `claude-haiku-4-5-20251001`  → `Haiku 4.5` (the trailing release date is dropped)
 *  - `claude-opus`                → `Opus` (no version segment)
 *  - An id we can't confidently parse (no `claude-` prefix, or a legacy
 *    number-first id like `claude-3-5-sonnet-…`) → the raw string, so an
 *    unfamiliar shape stays legible rather than rendering as garbage —
 *    matching `formatPermissionMode`'s raw-fallback discipline.
 */
export function formatModelLabel(model: string): string {
  // Peel the `[1m]` extended-context suffix first; it's orthogonal to the
  // family/version parse.
  const extended = model.endsWith(EXTENDED_SUFFIX);
  const base = extended ? model.slice(0, -EXTENDED_SUFFIX.length) : model;

  // Without the vendor prefix we can't parse family/version — fall back raw.
  if (!base.startsWith(CLAUDE_PREFIX)) {
    return model;
  }
  const parts = base
    .slice(CLAUDE_PREFIX.length)
    .split("-")
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    return model;
  }

  // Modern ids are family-first (`opus`, `sonnet`, `haiku`). A number-first
  // id is the legacy `claude-3-5-sonnet-…` shape we don't format — bail raw.
  const family = parts[0];
  if (!/^[a-z]/i.test(family)) {
    return model;
  }
  const familyLabel = family.charAt(0).toUpperCase() + family.slice(1);

  // Version components are the short numeric tokens after the family
  // (`4`, `8`). A long all-digit token is the release date (`20251001`) —
  // stop collecting there; a non-numeric token also stops it.
  const version: string[] = [];
  for (const token of parts.slice(1)) {
    if (/^\d{1,2}$/.test(token)) {
      version.push(token);
    } else {
      break;
    }
  }

  const core =
    version.length > 0 ? `${familyLabel} ${version.join(".")}` : familyLabel;
  return extended ? `${core} · ${EXTENDED_LABEL}` : core;
}

/**
 * Strip a trailing parenthetical from a catalog display name —
 * `Default (recommended)` → `Default` — for chip-width contexts. The picker
 * sheet keeps the full name (it has the room).
 */
export function stripDisplayNameParenthetical(displayName: string): string {
  return displayName.replace(/\s*\([^)]*\)\s*$/, "");
}

/**
 * Compress the verbose extended-context phrase in claude's model wording
 * into the chip's ` · 1M` annotation idiom:
 * `Opus 4.8 with 1M context` → `Opus 4.8 · 1M`. Text without the phrase
 * passes through unchanged.
 */
export function compressContextPhrase(text: string): string {
  return text.replace(
    /\s+with\s+(\d+(?:\.\d+)?\s*[MK])\s+context\b/i,
    (_m, size: string) => ` · ${size.replace(/\s+/g, "")}`,
  );
}

/**
 * A bare context-window annotation as claude's own wording spells it —
 * `1M`, `200K` — the whole of a `·`-separated segment.
 */
const CONTEXT_ANNOTATION = /^\d+(?:\.\d+)?\s*[MK]$/i;

/**
 * Whether a `·`-separated description segment is nothing but a context-window
 * annotation ({@link CONTEXT_ANNOTATION}) — the second segment of claude's
 * newer wording, `Opus 5 · 1M · Best for everyday, complex tasks`.
 */
export function isContextAnnotation(segment: string): boolean {
  return CONTEXT_ANNOTATION.test(segment.trim());
}

/**
 * A model name's shape: a family word, then a version (`Opus 5.5`,
 * `Haiku 4.5 …`) — what tells a name-bearing description from a tagline.
 */
const MODEL_NAME_SHAPE = /^[a-z]+\s+\d+(?:\.\d+)*\b/i;

/**
 * The "name with version" title for a capability/catalog row, from claude's
 * own wording.
 *
 * Claude has shaped a row two ways. Through 2.1.276 the name led the
 * `description` and `displayName` was a bare family (`displayName: "Fable"`,
 * `description: "Fable 5.1 · Most capable…"`). From 2.1.285 `displayName` is
 * the versioned name and `description` is only the tagline
 * (`displayName: "Opus 5.5"`, `description: "For complex work…"`) — except
 * the `default` row, which still leads its description with the name it
 * resolves to (`"Opus 5.5 · Best for everyday…"`, or the bare `"Fable 5.1"`).
 * So the leading `·`-separated segment is the title when it has a name's
 * shape — a family word then a version number ({@link MODEL_NAME_SHAPE}) —
 * plus the context-window annotation when claude states one. Anything else
 * is a tagline, and the title is the display name.
 *
 * Claude has spelled that annotation two ways, and both must survive as the
 * chip's ` · 1M`: inline in the name segment (`"Opus 4.8 with 1M context ·
 * Best…"`, compressed by {@link compressContextPhrase}) and as a segment of
 * its own (`"Opus 5 · 1M · Best…"`, kept here). Taking only the first segment
 * dropped the window from the newer wording, so a 1M model read as a bare
 * `Opus 5` — the same staleness that mis-sized the context gauge.
 *
 * A row without a name-bearing description falls back to its display name,
 * parenthetical stripped.
 */
export function modelRowTitle(row: CapabilityModel): string {
  if (row.description !== undefined) {
    // Isolate the leading name segment FIRST, then compress — compressing
    // first would introduce the very `·` the split keys on.
    const segments = row.description.split("·").map((s) => s.trim());
    const name = MODEL_NAME_SHAPE.test(segments[0])
      ? compressContextPhrase(segments[0])
      : "";
    if (name.length > 0) {
      const annotation = segments[1];
      return annotation !== undefined && isContextAnnotation(annotation)
        ? `${name} · ${annotation}`
        : name;
    }
  }
  return stripDisplayNameParenthetical(row.displayName);
}

/**
 * The model row a model string belongs to. `model` may be an exact resolved
 * id (`claude-sonnet-4-6`), a picker selector (`sonnet`), or an optimistic
 * display label (`Sonnet 4.6`).
 *
 * Five tiers, most-certain first. The `default` row is out of play past the
 * exact tier — it names no particular model, so nothing may drift onto it.
 *
 *  1. **Exact selector value.**
 *  2. **Canonical key** ([model-selector.ts] `canonicalModelKey`) — the same
 *     model under a different spelling (`claude-fable-5` ↔ the catalog's
 *     `claude-fable-5[1m]`).
 *  3. **Same name** — the row's title ({@link modelRowTitle}) equals the
 *     string's parsed label ({@link formatModelLabel}), so a resolved
 *     `claude-opus-5-5` finds claude's `opus` row titled `Opus 5.5`. From
 *     2.1.285 the catalog pairs short family selectors with older versioned
 *     ids of the same family (`opus` is Opus 5.5, `claude-opus-5` is Opus 5),
 *     so the name is the one fact that tells them apart.
 *  4. **Token-boundary containment** — the row's value appearing inside the
 *     string, which is what maps an optimistic display label (`Sonnet 4.6`)
 *     back to its row.
 *  5. **Family/version prefix relation** — a short family selector against a
 *     versioned id (`opus[1m]` ↔ `claude-opus-5`). Claude's catalog spells
 *     the row `opus[1m]` while the resolved id it reports is `claude-opus-5`,
 *     and the JSONL a resume replays records the bare `claude-opus-5`; without
 *     this tier a resumed session matches no row at all and every derived
 *     value (label, selector, context-window max) falls to its unknown
 *     default. Same relation `resolveCatalogSelector` uses, so a selector and
 *     a resolved id resolve to the same row.
 *
 * The containment pass is deliberately narrow, because the rows are untrusted:
 * they come from claude's live capabilities or from the catalog persisted in
 * tugbank, so a malformed or non-model row can be present. A bare `includes`
 * let such a row match EVERY model id — a row whose value is a fragment like
 * `e`, or the vendor prefix itself, sits inside every id — and the chip then
 * showed that row's title for every session. Two rules keep the match honest:
 *
 *  - **Vendor prefix is not evidence.** `claude-` leads every id, so it
 *    discriminates nothing; it is stripped from both sides before comparing.
 *  - **Token boundaries only.** The row's value must sit at the start/end of
 *    the string or against a non-alphanumeric neighbor, so `sonnet` matches
 *    `claude-sonnet-4-6` but `e` never matches inside `sonnet`.
 *  - **A version is whole.** A value ending in a version number must not be
 *    followed by another version segment, so `claude-opus-5` never matches
 *    inside `claude-opus-5-5` — a different model, not a spelling of it.
 *
 * Among surviving containment candidates the LONGEST value wins, so a specific
 * row beats a generic one rather than the match depending on row order. The
 * key tiers break ties by catalog order — claude's own ordering,
 * most-preferred first.
 */
function stripVendorPrefix(s: string): string {
  return s.startsWith(CLAUDE_PREFIX) ? s.slice(CLAUDE_PREFIX.length) : s;
}

/** True when `needle` occurs in `haystack` delimited by non-alphanumerics. */
function containsAtTokenBoundary(haystack: string, needle: string): boolean {
  const versioned = /\d$/.test(needle);
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : haystack[at - 1];
    const afterIndex = at + needle.length;
    const after = afterIndex >= haystack.length ? "" : haystack[afterIndex];
    const opens = before === "" || !/[a-z0-9]/.test(before);
    const closes = after === "" || !/[a-z0-9]/.test(after);
    const extendsVersion =
      versioned && /^[-.]\d{1,2}(?!\d)/.test(haystack.slice(afterIndex));
    if (opens && closes && !extendsVersion) return true;
    from = at + 1;
  }
}

export function findModelRow(
  model: string,
  rows: CapabilityModel[],
): CapabilityModel | null {
  const lower = model.trim().toLowerCase();
  const exact = rows.find((r) => r.value.trim().toLowerCase() === lower);
  if (exact !== undefined) return exact;

  const concrete = rows.filter(
    (r) => r.value !== "default" && r.value.length > 0,
  );
  const key = canonicalModelKey(lower);

  if (key.length > 0) {
    const sameKey = concrete.find((r) => canonicalModelKey(r.value) === key);
    if (sameKey !== undefined) return sameKey;
  }

  const label = formatModelLabel(model.trim()).toLowerCase();
  const sameName = concrete.find(
    (r) => modelRowTitle(r).toLowerCase() === label,
  );
  if (sameName !== undefined) return sameName;

  const haystack = stripVendorPrefix(lower);
  let best: CapabilityModel | null = null;
  let bestLength = 0;
  for (const row of concrete) {
    const needle = stripVendorPrefix(row.value.toLowerCase());
    if (needle.length === 0) continue;
    if (!containsAtTokenBoundary(haystack, needle)) continue;
    if (needle.length > bestLength) {
      best = row;
      bestLength = needle.length;
    }
  }
  if (best !== null) return best;

  if (key.length > 0) {
    const related = concrete.find((r) => {
      const rowKey = canonicalModelKey(r.value);
      return isKeyPrefix(key, rowKey) || isKeyPrefix(rowKey, key);
    });
    if (related !== undefined) return related;
  }
  return null;
}

/**
 * The rows a label/selector resolution should consult: the live capability
 * list when present, else the persisted catalog, else nothing. Real data
 * only — there is no hardcoded model list.
 */
export function knownModelRows(
  models: CapabilityModel[],
  catalog: CapabilityModel[] | null,
): CapabilityModel[] {
  return models.length > 0 ? models : (catalog ?? []);
}

/**
 * THE model label — the one path every surface shares ([P01]-grade:
 * consistency by construction, not by parallel implementations).
 *
 *  - `model === null` (session hasn't resolved one): the first row's title —
 *    the account default by convention — or `null` when nothing is known
 *    (callers show `?`).
 *  - A row matches (`findModelRow` handles ids, selectors, and optimistic
 *    labels alike): that row's {@link modelRowTitle}.
 *  - No row but the string is the `default` selector: `"Default"` — the
 *    honest zero-state word, since with no data we cannot say what the
 *    account default resolves to.
 *  - Anything else: {@link formatModelLabel} parses the id shape.
 */
export function resolveModelLabel(
  model: string | null,
  rows: CapabilityModel[],
): string | null {
  if (model === null) {
    return rows.length > 0 ? modelRowTitle(rows[0]) : null;
  }
  const row = findModelRow(model, rows);
  if (row !== null) return modelRowTitle(row);
  if (model === "default") return "Default";
  return formatModelLabel(model);
}
