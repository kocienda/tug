/**
 * The page's entry: which page this document is.
 *
 * `index.html` serves every page the host makes, and the query says which one
 * it is to be: no `?body=` is the deck, `?body=spike` is the display-rate
 * spike's child page (`body/spike-page.ts`), and any other `?body=` is a
 * card's body (`body/body-main.ts`) — `?body=<cardId>` cold, `?body=spare`
 * the warm spare waiting for its card. The choice has to be made here,
 * before the deck's module graph evaluates: `main.tsx`'s static imports run
 * their side effects and its module scope constructs the deck's connection, so
 * nothing inside it could decide to stop.
 *
 * @module entry
 */

const page = new URLSearchParams(window.location.search).get("body");

if (page === "spike") {
  void import("./body/spike-page");
} else if (page !== null && page.length > 0) {
  void import("./body/body-main");
} else {
  void import("./main");
}
