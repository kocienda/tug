# Tug — local test build

These notes exist to be *rendered*. `local-appcast.sh` hands this file to
`generate_appcast`, which embeds it in the feed it serves, so the popover's
release-notes pane has something with shape in it during the manual
end-to-end pass.

## What to look at

- The heading above, this paragraph, and this list, all through the deck's own
  markdown renderer rather than a `WebView`.
- `inline code`, **bold**, and a [link](https://github.com/kocienda/tug).
- Enough lines to reach the pane's scroll cap, which is the case a real
  changelog will hit.

> A block quote, because the renderer has to answer for one.

## Filler, so the pane scrolls

1. The pill is in the upper right and has not taken focus.
2. The popover opened because the check was user-initiated.
3. *Install and Relaunch* names any session that is mid-turn.
4. *Later* at ready-to-install says the update lands on the next quit.
5. Cancel is offered while there is something to cancel and not otherwise.
6. Progress moves without React rendering anything.
7. A failure reads as a caution with Retry, and does not go away on a timer.
8. None of the above is blocked by these notes being absent, which is the
   other half of the case worth seeing.
