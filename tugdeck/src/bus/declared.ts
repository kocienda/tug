/**
 * Every shared store, routed action and request this realm has defined.
 *
 * Store keys, action ids and request ids share one namespace — a store's
 * proposals ride `action` envelopes under the store's key — so a second
 * definition of any key throws. The registry's conformance test compares
 * what is defined with what `bus/registry.ts` lists.
 *
 * @module bus/declared
 */

export type DeclarationKind = "store" | "action" | "request";

export interface Declared {
  readonly kind: DeclarationKind;
  readonly key: string;
}

const defined = new Map<string, Declared>();

export function recordDeclaration(declaration: Declared): void {
  const prior = defined.get(declaration.key);
  if (prior !== undefined) {
    throw new Error(`bus: "${declaration.key}" is already declared as a ${prior.kind}`);
  }
  defined.set(declaration.key, declaration);
}

export function definedDeclarations(): readonly Declared[] {
  return [...defined.values()];
}
