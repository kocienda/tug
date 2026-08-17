/**
 * useSessionCardServices — per-card services consumed by `SessionCardContent`.
 *
 * Split out of `session-card.tsx` so that file stays a component-only React Fast
 * Refresh boundary: a `.tsx` that exports a hook alongside its components is
 * "mixed" and non-accepting, so editing it (or anything it transitively
 * imports) full-reloads. This module owns the hook; `session-card.tsx` imports it.
 *
 * **Laws:** [L02] — services enter React through `useSyncExternalStore` over
 * the module-scope `cardServicesStore` only; the store owns construction and
 * disposal in response to `cardSessionBindingStore` events. React only reads.
 * The hook never holds services in `useState` or tears them down from an
 * effect (an earlier shape that did so violated [L02] and sent stray
 * `close_session` frames).
 *
 * @module components/tugways/cards/use-session-card-services
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { cardServicesStore, type CardServices } from "@/lib/card-services-store";
import { PromptHistoryStore } from "@/lib/prompt-history-store";
import type { CompletionProvider } from "@/lib/tug-text-types";
import type { ArgumentHintResolver } from "@/components/tugways/tug-text-editor/argument-hint-extension";
import type { PastedCommandResolver } from "@/components/tugways/tug-text-editor/clipboard-filters";
import type { AtomSegment } from "@/lib/tug-atom-img";
import {
  resolveInlineGhostName,
  type InlineCommandMatcher,
} from "@/lib/inline-command-ghost";
import { resolveArgumentHint } from "@/lib/slash-argument-hint";
import { LOCAL_SLASH_COMMANDS, type LocalSlashCommandSpec } from "@/lib/slash-commands";
import { isHiddenSlashCommand } from "@/lib/slash-supported";
import { isCompactionLowEffect } from "@/lib/code-session-store/telemetry";
import { wrapPositionZero } from "./completion-providers/position-zero";
import {
  filterCommandProvider,
  localCommandCompletionProvider,
  mergeCommandProviders,
} from "./completion-providers/local-commands";
import type { TugPromptEntryDelegate } from "../tug-prompt-entry";
import type { SessionCardServices } from "./session-card";

/** Stable empty `@` provider used while services aren't ready. */
const EMPTY_FILE_COMPLETION_PROVIDER = ((_q: string) => []) as CompletionProvider;

// Lazily-constructed singleton prompt-history store shared across dev cards.
// The store is internally keyed by session id (see `lib/prompt-history-store.ts`);
// every `push()` appends to the machine-global prompt ledger, and each session's
// entries page back in on first access. Cross-card reuse of history for the same
// project arrives once a stable per-workspace session id exists.
let _devPromptHistoryStore: PromptHistoryStore | null = null;
function getSessionPromptHistoryStore(): PromptHistoryStore {
  if (_devPromptHistoryStore === null) {
    _devPromptHistoryStore = new PromptHistoryStore();
  }
  return _devPromptHistoryStore;
}

export function useSessionCardServices(cardId: string): SessionCardServices | null {
  // Read services from the module-scope `cardServicesStore` via
  // `useSyncExternalStore` ([L02]). The store handles all lifecycle:
  // it subscribes to `cardSessionBindingStore` and constructs/disposes
  // services in response to binding events. React only reads.
  //
  // Earlier this hook stored services in `useState` and populated them
  // via `useLayoutEffect` keyed on the binding. That violated [L02]
  // and produced a class of bugs where any React-side dep change tore
  // services down, sent a stray `close_session` frame, and remounted
  // the picker mid-session. The wire close is now sent only by
  // explicit `cardServicesStore.closeCard(cardId)` calls from the
  // deck-canvas's user-close handler.
  const services = useSyncExternalStore<CardServices | null>(
    cardServicesStore.subscribe,
    useCallback(() => cardServicesStore.getServices(cardId), [cardId]),
  );

  // True ref: the delegate instance arrives after the child
  // TugPromptEntry commits, so it cannot be initialized eagerly. Kept
  // here so the `/` position-0 gate (in `completionProviders`) reads
  // the same identity the component passes to `<TugPromptEntry ref>`.
  const entryDelegateRef = useRef<TugPromptEntryDelegate | null>(null);

  // Completion providers. Null-safe on `services` so this can be
  // memoized unconditionally (rules of hooks); the caller only reads
  // it when `services` is non-null. The `@` provider falls back to
  // an empty stable closure when services aren't ready, so the
  // trigger stays wired regardless of timing. The `/` provider is
  // wrapped with the position-0 gate so `/` mid-text yields an empty
  // popup.
  // Base (un-gated) command-completion provider: local graphical commands
  // merged with claude's reported commands (allowlist-filtered). Local commands
  // are listed first so a name claude also reports resolves to the local entry.
  // `/rewind` is always offered (never gated on a rewind target) — opening it
  // with nothing to rewind to shows an explanatory empty-state sheet. Shared by
  // the `/` popup (position-0 gated) and the mid-text inline ghost matcher.
  const commandMatchProvider = useMemo<CompletionProvider | null>(() => {
    if (services === null) return null;
    const codeSessionStore = services.codeSessionStore;
    return mergeCommandProviders(
      localCommandCompletionProvider({
        // [P08] minimal-effect hint: when the conversation is much smaller than
        // the base, `/compact` frees little — tint the `compact` row's muted
        // description to say so (read live per query [L07]; never gates it).
        descriptionOverride: (name) => {
          if (name !== "compact") return undefined;
          const snap = codeSessionStore.getSnapshot();
          return isCompactionLowEffect(snap.transcript, snap.sessionInitTokens)
            ? "Compact — frees little; most context is fixed base"
            : undefined;
        },
      }),
      filterCommandProvider(
        services.sessionMetadataStore.getCommandCompletionProvider(),
        (name) => !isHiddenSlashCommand(name),
      ),
    );
  }, [services]);

  const completionProviders = useMemo<Record<string, CompletionProvider>>(
    () => ({
      "@": services?.fileCompletionProvider ?? EMPTY_FILE_COMPLETION_PROVIDER,
      // Position-0 gated: a leading `/` opens the descriptive popup; mid-text
      // yields an empty popup (the inline ghost covers that case instead).
      "/": commandMatchProvider
        ? wrapPositionZero(entryDelegateRef, "/", commandMatchProvider)
        : EMPTY_FILE_COMPLETION_PROVIDER,
    }),
    [services, commandMatchProvider],
  );

  // Inline ghost matcher: scan the ranked catalog for the best case-insensitive
  // prefix-extension of the typed query, preferring a full-name hit and falling
  // back to a namespaced command's leaf (`/dev` → `devise` for `tugplug:devise`)
  // so plugin commands ghost too. Returns null when nothing prefix-extends the
  // query — the only case the ghost stays dark (a fuzzy-only match never ghosts;
  // the popup, not the ghost, is where fuzzy discovery happens). Read live
  // through the provider closure [L07].
  const inlineCommandMatcher = useMemo<InlineCommandMatcher>(() => {
    if (commandMatchProvider === null) return () => null;
    return (query: string): string | null =>
      resolveInlineGhostName(
        commandMatchProvider(query).map((item) => item.label),
        query,
      );
  }, [commandMatchProvider]);

  // Argument-hint resolver: maps an accepted command atom's value to its
  // placeholder by reading the LIVE command catalog (skill/agent category +
  // any explicit hint the emitter shipped) and the local registry (its
  // `takesArgs` flag), deferring the decision to the pure `resolveArgumentHint`.
  // Read live so a hint that lands after the `initialize` handshake takes
  // effect without rebuilding the editor.
  const argumentHintResolver = useMemo<ArgumentHintResolver>(() => {
    if (services === null) return () => null;
    const store = services.sessionMetadataStore;
    return (value: string): string | null => {
      const catalogHit = store
        .getSnapshot()
        .slashCommands.find((c) => c.name === value);
      const local: LocalSlashCommandSpec | undefined = LOCAL_SLASH_COMMANDS.find(
        (c) => c.name === value,
      );
      return resolveArgumentHint({
        name: value,
        category: catalogHit?.category,
        argumentHint: catalogHit?.argumentHint,
        takesArgs: local?.takesArgs,
      });
    };
  }, [services]);

  // Pasted-command resolver: maps a `/command` at the start of pasted text to
  // the atom to chip it as. Scans the same ranked catalog the popup uses for an
  // entry whose full name OR unqualified leaf exactly equals the token — the
  // paste-time mirror of the typed `/command ` accept rule. Read live [L07].
  const pastedCommandResolver = useMemo<PastedCommandResolver>(() => {
    if (commandMatchProvider === null) return () => null;
    return (token: string): AtomSegment | null => {
      const hit = commandMatchProvider(token).find((item) => {
        if (item.label === token) return true;
        const colon = item.label.lastIndexOf(":");
        return colon >= 0 && item.label.slice(colon + 1) === token;
      });
      return hit?.atom ?? null;
    };
  }, [commandMatchProvider]);

  return useMemo<SessionCardServices | null>(() => {
    if (services === null) return null;
    return {
      codeSessionStore: services.codeSessionStore,
      sessionMetadataStore: services.sessionMetadataStore,
      historyStore: getSessionPromptHistoryStore(),
      completionProviders,
      argumentHintResolver,
      inlineCommandMatcher,
      pastedCommandResolver,
      editorStore: services.editorStore,
      transcriptStore: services.transcriptStore,
      skillsInventoryStore: services.skillsInventoryStore,
      hooksInventoryStore: services.hooksInventoryStore,
      sideQuestionStore: services.sideQuestionStore,
      shellSessionStore: services.shellSessionStore,
      refsSessionStore: services.refsSessionStore,
      pathCommandsStore: services.pathCommandsStore,
      shellGrammarStore: services.shellGrammarStore,
      shellClassifyStore: services.shellClassifyStore,
      changesController: services.changesController,
      pendingContextStore: services.pendingContextStore,
      entryDelegateRef,
    };
  }, [
    services,
    completionProviders,
    argumentHintResolver,
    inlineCommandMatcher,
    pastedCommandResolver,
  ]);
}
