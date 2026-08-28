---
name: spike-card
description: Scaffold a design spike card onto the deck — an exploratory surface in tugdeck/src/spikes/, never a Component Gallery card
argument-hint: "[what you want to explore]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
disallowed-tools: Task
---

## What this is

`spike-card` makes a **design spike** — an exploratory surface on the deck where you try a layout, a typography question, a comparison between two treatments, or the shape of a card that is not a component yet. It writes one file in `tugdeck/src/spikes/`, adds two lines to the registry, verifies the build, and tells you how to open it.

A spike is not a Component Gallery card. The gallery holds exemplary demos of established `Tug*` components — proper usage, the range of an API, meant to be browsed as documentation. A spike holds an idea. If your surface is really a demo of a shipping component, put it in `tugdeck/src/components/tugways/cards/gallery-registrations.tsx` instead and stop here.

A spike is also not an app-test fixture. A card whose only consumer is the test harness belongs in `tugdeck/src/fixtures/`.

The authority on the contract is [`tugdeck/src/spikes/README.md`](../../../tugdeck/src/spikes/README.md). Read it before scaffolding; this skill is the procedure, that file is the rule.

## Input

`/tugplug:spike-card <what you want to explore>`

A sentence is enough — "compare three treatments for the composer's attachment strip". If the invocation gives nothing, ask what the spike is exploring before writing anything; the `blurb` is the one field that cannot be invented, because it is what the index card shows the reader.

## The flow

1. **Name it.** Derive a kebab-case slug from the subject (`attachment-strip`), and confirm `tugdeck/src/spikes/spike-<slug>.tsx` does not already exist. The componentId will be `spike-<slug>`; the title is the human form ("Attachment Strip").

2. **Write the file.** Copy the skeleton from `spikes/README.md`. It exports the component and a `SpikeDef` carrying `name`, `title`, `blurb`, and `component`. Add `icon` when a lucide name fits the subject better than the default flask; add `size` only if the spike genuinely needs unusual room; add `kbfAtRest: true` only if the spike's subject *is* the focus language.

   Give the file a real module docstring stating the question the spike is asking. That question and the `blurb` are the same sentence in two registers.

3. **Register it.** Two lines in `spikes/spike-registry.tsx`: the `import { spike as <name>Spike } from "./spike-<slug>"`, and the entry in the `SPIKES` array. Nothing else — the family, accepted families, size policy, category, and closable flag are answered once there for every spike at once.

4. **Style it.** `spike.css` gives you `.sp-content`, `.sp-section`, `.sp-section-title`. Anything more goes in a sibling `spike-<slug>.css` that the spike imports itself.

5. **Verify.** From `tugdeck/`: `bunx tsc --noEmit` and `bunx vite build` both exit 0, and `bun test src/__tests__/card-taxonomy.test.ts` passes — the last one will fail if the spike registered under the wrong family or the spike count pin is now stale, and the pin is the thing to update.

6. **Say how to open it.** Maker ▸ New Spikes Card, then click the new row. Mention that a freshly-opened Spikes pane holds one card, so the pane's `+` picker offers only standard cards until an index row has added a spike — the rows are the way in, not a convenience.

## Guardrails

- **Compose, never hand-roll** ([L20]). A spike that reinvents a list, a button, or a popover is exploring the wrong thing. Reach for the `Tug*` components first; that is what makes a spike's findings transferable.
- **Tokens, not hex** ([L15]). A spike in raw colors cannot be judged across themes, which is usually the whole point of looking at it.
- **No gallery classes, no `gallery.css` import** ([L16]). The spikes sandbox owns its own vocabulary; a drift test greps for violations.
- **No `localStorage`.** Persistent state goes through tugbank, in a spike as everywhere else.
- **External state via `useSyncExternalStore`** ([L02]), appearance through CSS and DOM rather than React state ([L06]), and controls that emit actions rather than mutating structure themselves ([L11]).
- **Never `hidden: true`.** A spike nobody can see is a dead spike. Hidden is what fixtures are.
- **Never commit.** Landing is the user's act.

## Getting out

Say this when the spike is made, because it is the part everyone forgets. A spike has two exits and neither is "leave it there":

- **Graduate it** — component work moves to `components/tugways/`, durable findings move to `tuglaws/`, the spike file is deleted.
- **Delete it** — the file and its two registry lines.

One after-effect worth stating plainly: deleting a spike that is open in a saved layout drops that pane on next launch, with a `[DeckManager] filterRegisteredCards: dropping card …` console warning. That is correct behavior — a card whose componentId no longer resolves is removed, and a pane left empty goes with it — but a pane vanishing is worth having been warned about rather than discovered.
