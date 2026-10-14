/**
 * scope-to-card.ts — address one RPC to a card's body view.
 *
 * Every view verb (`evalJS`, `waitForCondition`, `getElementScreenBounds`,
 * `screenshot`, the native verbs) takes an optional `card`: absent, it runs
 * in the shell; present, in that card's body. `BodyApp` passes every
 * request's params through this one function, so no verb can forget the
 * card. Pure, over data.
 */

/**
 * `params` with `card` set to `cardId`, every other field kept. A params
 * object that already names a different card is a caller's mistake — two
 * views claimed for one request — and throws rather than picking one.
 */
export function scopeToCard(
  params: Record<string, unknown>,
  cardId: string,
): Record<string, unknown> {
  const named = params.card;
  if (named !== undefined && named !== cardId) {
    throw new Error(
      `[harness] scopeToCard: params already name card ${JSON.stringify(named)}, not ${JSON.stringify(cardId)}`,
    );
  }
  return { ...params, card: cardId };
}
