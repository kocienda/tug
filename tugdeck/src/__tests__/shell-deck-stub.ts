/**
 * Register a test's stand-in for the shell's deck.
 *
 * A test that needs a shell deck hands the registry a narrow double: the two
 * or three members its subject reads, cast to `IDeckManagerStore`. But the
 * registry is the page's, and page singletons outlive the file that woke
 * them. The restore gate (`restore-gate-store.ts`) is one: once any file has
 * read it, it folds on every body-card and card-services change in every
 * later file, and each fold follows the registered deck's workspaces. A
 * double with no workspaces facet throws there, inside a store's notify, in
 * a file that never named the gate — green alone and red in the suite, by
 * whichever order the files ran in.
 *
 * So a double goes in through here, which states the facet every real shell
 * deck has for any member the test left out: no card is in a workspace,
 * none is shown, and nothing ever changes. A test about workspaces states
 * its own and they stand.
 *
 * The members are filled in on the object itself, so `getShellDeck()` still
 * returns the test's own double.
 */

import { registerShellDeck } from "@/lib/deck-store-registry";
import type { IDeckManagerStore } from "@/deck-manager-store";

export function registerStubShellDeck(stub: IDeckManagerStore): void {
  const deck = stub as unknown as Record<string, unknown>;
  deck.spaceOf ??= () => null;
  deck.getSpacesSnapshot ??= () => ({ activeSpaceId: null });
  deck.subscribeSpaces ??= () => () => {};
  registerShellDeck(stub);
}
