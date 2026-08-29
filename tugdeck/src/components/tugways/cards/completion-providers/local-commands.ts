/**
 * local-commands.ts — slash-completion provider for the local-command
 * registry, plus a small provider-merge helper.
 *
 * The session card's `/` completion comes from claude (skills, agents,
 * claude's own slash commands) via
 * `SessionMetadataStore.getCommandCompletionProvider()`. Locally-handled
 * commands ([D23], `lib/slash-commands.ts`) are *not* claude's, so they
 * are not in that set — the session card merges them in at its composition
 * layer (where the `/` provider is already assembled and wrapped with
 * `wrapPositionZero`). Doing the merge here, not inside
 * `SessionMetadataStore`, keeps the store generic and keeps local
 * commands out of other hosts' popups (e.g. the gallery, which calls the
 * store provider directly).
 *
 * Pure: depends only on the shared text-engine types and the registry.
 *
 * @module components/tugways/cards/completion-providers/local-commands
 */

import type { CompletionItem, CompletionProvider } from "@/lib/tug-text-types";
import { LOCAL_SLASH_COMMANDS, type LocalCommandName } from "@/lib/slash-commands";
import { scoreCommandMatch } from "@/lib/text-match";

/** Options for {@link localCommandCompletionProvider}. */
export interface LocalCommandProviderOptions {
  /**
   * Per-command availability gate, evaluated fresh on every query so it can
   * read live state (e.g. `/rewind` is offered only once the session has a
   * rewind target — [#step-7-3] empty-state gating). Omitted ⇒ every
   * registered command is offered.
   */
  isOffered?: (name: LocalCommandName) => boolean;
  /**
   * Per-command description override, evaluated fresh on every query so it can
   * read live state ([P08]: the `/compact` minimal-effect hint when the
   * conversation is much smaller than the base). Returning `undefined` keeps
   * the static registry description; the command is never gated by this — only
   * its muted description column changes.
   */
  descriptionOverride?: (name: LocalCommandName) => string | undefined;
}

/**
 * A `CompletionProvider` over {@link LOCAL_SLASH_COMMANDS}. Items are the same
 * shape as claude's slash-command completions (`atom.type = "command"`), so
 * accepting one inserts a command atom and dismisses the popup exactly like
 * any other slash command — the completion layer draws no local/remote
 * distinction. The split happens later, at submit: `performSubmit` recognizes
 * a *local* command atom and opens its surface; everything else is sent to
 * claude ([#step-1c] / [D23]).
 *
 * Matched and ranked by {@link scoreMatch} so the popup feels identical to the
 * `@`-file popup: each item carries highlight `matches` ranges, and final
 * ordering is by score (applied in {@link mergeCommandProviders}). An empty
 * query offers every command (no filter).
 */
export function localCommandCompletionProvider(
  options: LocalCommandProviderOptions = {},
): CompletionProvider {
  const { isOffered, descriptionOverride } = options;
  return (query: string): CompletionItem[] => {
    const items: CompletionItem[] = [];
    for (const cmd of LOCAL_SLASH_COMMANDS) {
      if (isOffered !== undefined && !isOffered(cmd.name)) continue;
      const match = scoreCommandMatch(query, cmd.name);
      if (match === null) continue;
      items.push({
        label: cmd.name,
        atom: {
          kind: "atom",
          type: "command",
          label: cmd.name,
          value: cmd.name,
        },
        matches: match.matches.map(([s, e]) => [s, e] as [number, number]),
        description: descriptionOverride?.(cmd.name) ?? cmd.description,
      });
    }
    return items;
  };
}

/**
 * Wrap a command provider, dropping items whose command name (the item
 * `label`) fails `keep`. The session card uses this to apply the [D14] allowlist
 * over claude's reported commands — hiding the known-unsupported set
 * ([#step-13a]) — at the composition layer, so the generic
 * `SessionMetadataStore` stays free of session-card command policy (the same
 * reasoning that keeps the local-command merge out of the store).
 *
 * Synchronous only, matching the command providers it wraps.
 */
export function filterCommandProvider(
  provider: CompletionProvider,
  keep: (name: string) => boolean,
): CompletionProvider {
  return (query: string): CompletionItem[] =>
    provider(query).filter((item) => keep(item.label));
}

/**
 * Merge command providers into one, de-duplicating by command label, and
 * present the result **alphabetically by label** (case-insensitive). Two
 * separate concerns:
 *
 * - **Dedup precedence** decides which item *survives* when a name appears in
 *   more than one provider: first-wins, so listing the local provider first
 *   means a name claude also reports resolves to the local (graphical) entry.
 * - **Display order** is by match quality (descending {@link scoreMatch}
 *   score), with alphabetical as the tiebreak — so `/permi` ranks
 *   `permissions` (a prefix hit) above `fewer-permission-prompts` (a
 *   word-boundary hit) instead of letting the alphabet decide. The score is
 *   recomputed here from each surviving item's label against the live query;
 *   the providers don't thread a score through the `CompletionItem` shape, and
 *   re-scoring a ≤ 50-item list per keystroke is free. For an empty query
 *   `scoreMatch` returns no score, so every item ties and the ordering falls
 *   back to purely alphabetical — the previous behavior, preserved.
 *
 * Synchronous only — command providers don't carry the async `subscribe` hook
 * that file completion uses.
 */
export function mergeCommandProviders(
  ...providers: readonly CompletionProvider[]
): CompletionProvider {
  return (query: string): CompletionItem[] => {
    const seen = new Set<string>();
    const merged: CompletionItem[] = [];
    for (const provider of providers) {
      for (const item of provider(query)) {
        if (seen.has(item.label)) continue;
        seen.add(item.label);
        merged.push(item);
      }
    }
    merged.sort((a, b) => {
      const scoreA = scoreCommandMatch(query, a.label)?.score ?? 0;
      const scoreB = scoreCommandMatch(query, b.label)?.score ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    });
    return merged;
  };
}
