/**
 * The page's entry: which page this document is.
 *
 * `index.html` serves every page the host makes, and the query says which one
 * it is to be: no `?body=` is the deck, `?body=spike` is the display-rate
 * spike's child page (`body/spike-page.ts`), and any other `?body=` is a
 * card's body (`body/body-main.ts`) — `?body=<cardId>` cold, `?body=spare`
 * the warm spare waiting for its card. `?overlay=` is the overlay the host
 * keeps above every card (`overlay/overlay-main.ts`). The choice has to be made here,
 * before the deck's module graph evaluates: `main.tsx`'s static imports run
 * their side effects and its module scope constructs the deck's connection, so
 * nothing inside it could decide to stop.
 *
 * @module entry
 */

const query = new URLSearchParams(window.location.search);
const page = query.get("body");

if (query.has("overlay")) {
  void import("./overlay/overlay-main");
} else if (page === "spike") {
  void import("./body/spike-page");
} else if (page !== null && page.length > 0) {
  void import("./body/body-main");
} else {
  void import("./main");
}
