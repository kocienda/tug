/**
 * position-zero.ts — position-gated completion-provider wrapper.
 *
 * Restricts a `CompletionProvider` to fire only when the trigger
 * character sits at the very start of the editor's text. Mid-text
 * triggers yield `[]`, so the engine still opens the popup on the
 * trigger but it's empty (per D5.c recommendation P1).
 *
 * Pure helper — depends only on the shared text-engine and prompt-entry
 * types; carries no build-time or capture-time dependencies. Used by the
 * Session card's `/` slash-command provider and by the gallery card.
 */

import type { CompletionProvider } from "@/lib/tug-text-types";
import type { PromptEntryDelegate } from "@/components/tugways/cards/prompt-entry";

/**
 * Wrap a `CompletionProvider` so it only yields results when the
 * trigger character is the first character of the editor's text.
 * `trigger` is the character the provider is registered under
 * (`"/"` for slash commands).
 */
export function wrapPositionZero(
  entryRef: React.RefObject<PromptEntryDelegate | null>,
  trigger: string,
  inner: CompletionProvider,
): CompletionProvider {
  return (query: string) => {
    const editor = entryRef.current?.getEditorElement();
    const text = editor?.textContent ?? "";
    if (text.length === 0 || text[0] !== trigger) return [];
    return inner(query);
  };
}
