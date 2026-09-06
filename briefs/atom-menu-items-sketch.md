# An entity that inserts as an atom says so, and copies as one

**Status:** sketch, scope settled. Ready for `/arc` once the per-kind label
rules in [The four kinds](#the-four-kinds) are read once with your eye on them.

The ask, from the right-click on `notes/arc-resolve-brief.md` in the transcript:

- **`Insert into Prompt` becomes `Insert Atom into Prompt`.** The item already
  mints a chip rather than typing characters; the label has never said so.
- **`Copy as Atom` joins it** — put the atom on the clipboard, so a paste into
  any Tug editor returns the chip instead of the string.

## The rule

> **An entity whose insert mints an atom names it in both directions:
> `Insert Atom into Prompt` to send it, `Copy as Atom` to take it. An entity
> that inserts as text keeps the plain `Insert into Prompt` and offers no atom
> copy.**

Stated as a rule and not as a list, so a kind promoted to atom-insert later
inherits both items with no menu edit. The label has to be true of what the
item does: for a command line, an email address, or a bare sha the insert is a
**jot** — text at the caret, no chip — and *Insert Atom into Prompt* there
would be a lie the menu tells three times.

## What is already true

`lib/annotator/registry.ts` is the only place a kind's item list and its order
are written ([tuglaws/menus.md](../tuglaws/menus.md#the-registry-states-the-items-the-surface-states-its-facts)),
so the mods are one edit that every surface inherits at once: transcript ink, a
placed composer atom, an `@` mention chip, an Overview citation, the shades.

Two machines exist and neither needs building:

- **`handleInsertIntoPrompt`** (`use-annotation-menu.tsx`) branches on
  `file-path` and calls `insertAtomDraft` with a `file` segment. Every other
  kind falls through to `insertJot`. That single branch becomes a lookup: *the
  atom segment for this payload, or `null`* — and `null` is exactly the
  predicate the rule keys both items off.
- **`writeCopyClipboard(plain, html, origin, atoms)`** already takes a
  `TugAtomsClipboardPayload` and routes it through the native bridge, degrading
  to a plain-text write in browser mode. `lib/session-atom.ts` is the working
  precedent for the sidecar shape: `{ version: 1, text: TUG_ATOM_CHAR, atoms:
  [{ position: 0, segment }] }`.

So `Copy as Atom` is `writeCopyClipboard(plainForm, null, origin(),
oneAtomSidecar(segment))` — one handler, fed by the same `segmentFor(payload)`
the insert now calls. The two gestures cannot drift, because there is one
segment builder and both read it.

## The four kinds

Today **only `file-path`** inserts as an atom. Four kinds have an atom form
built and unused; three of them are promoted here, so the rule picks them up:

| Kind | Atom type | Segment | Plain-text flavor | Status |
|---|---|---|---|---|
| `file-path` | `file` | exists — `formatAtomLabel(path, "filename")`, canonical path as value | the path | already inserts as an atom |
| `directory` | `directory` | new — last path segment as label, path as value | the path | **promote** |
| `url` | `link` | new — see below | the URL | **promote** |
| `session` | `session` | exists — `sessionAtomSegment(identity)` | the citation | **promote**, with a condition |
| `image` | `image` | — | — | **out**: the bytes live in a per-card `AtomBytesStore`, so a copied image atom pasted into another card is a chip with nothing behind it. Re-homing bytes across cards is a real feature and not this one. |
| `slash-command`, `shell-command`, `email`, `commit-sha` | — | — | — | out by the rule: they insert as text and their menus are untouched |

Three per-kind rules, each the only judgment call in the change:

- **`url` mints Tug's first real `link` atom.** Nothing in the product mints
  one today — only the gallery fixtures and the wire-payload tests do — so this
  invents the label rule. Propose: **the host, plus the last path segment when
  there is one** (`anthropic.com`, `anthropic.com/…/research`), truncated by the
  chip's own `maxLabelWidth`; the full URL is always the value. The gallery's
  fixtures already read that way, which is some evidence it is the right shape.
- **`directory` round-trips through a trailing separator.** `payloadForAtom`
  strips trailing slashes on the way in because the file index's directory form
  carries one. Mint the value **without** the separator and the round-trip is
  the identity function; that is the form to write.
- **`session` is offered its atom only where the identity resolves.** The
  payload carries an id and nothing else, and the atom is written from the
  identity **record** — project and callsign. `resolveSessionIdentity` is the
  sanctioned non-React snapshot for exactly this (clipboard writes are the use
  it names), but it is behind a grep gate that forbids calls from
  `components/`. So the session segment builder lives in `lib/session-atom.ts`
  beside `sessionAtomSegment` and the hook calls it — and when it answers
  `null` for a citation the ledger cannot resolve, the kind falls back to the
  plain jot insert and no atom copy, which is [L31] doing its usual job. The
  row surfaces that already show *Copy as Atom* from their own facts keep it
  and gain nothing; the transcript's session ink is what changes.

## The order

The file menu, after:

```
Open in Editor
Show in Finder
────
Copy Path
Copy as Atom            ← new
────
Insert Atom into Prompt ← renamed
```

`Copy as Atom` sits directly under `Copy Path` in the **[Copy it]** block: one
entity, second serialization, the same adjacency the session menu already has.
`Copy as Atom` also passes `registry.test.ts`'s copy-shape regex unchanged,
because `Copy as <Format>` is the sanctioned second shape and the atom beside
the citation is the example `menus.md` names.

The two rules are `menus.md`'s block boundaries. The file menu shows none today
only because its four items happened to fall in block order; a second copy is
what makes them visible. If they read heavy over five items, the boundaries can
stay implicit and only the order is load-bearing — worth one look at the
running app before the arc commits to them.

## The edits

| File | Change |
|---|---|
| `tugdeck/src/components/tugways/action-vocabulary.ts` | `COPY_ANNOTATION_ATOM: "copy-annotation-atom"`, with the comment block every action carries |
| `tugdeck/src/components/tugways/command-registry.ts` | add it to `ACTIONS_OUTSIDE_THE_TABLE`, beside `COPY_ANNOTATION_VALUE` — menu-only over a sampled target, no chord can name it |
| `tugdeck/src/lib/annotator/atom-segment.ts` *(new)* | `atomSegmentFor(payload): AtomSegment \| null` — the whole rule in one function: file, directory, link, session (delegating to `lib/session-atom.ts`), `null` for everything else |
| `tugdeck/src/lib/annotator/registry.ts` | each promoted kind's entries: the insert label and the `Copy as Atom` row, both gated on `atomSegmentFor` answering |
| `tugdeck/src/components/tugways/use-annotation-menu.tsx` | `handleCopyAnnotationAtom`; `handleInsertIntoPrompt` loses its `file-path` branch and calls `atomSegmentFor` |
| `tugdeck/src/lib/session-atom.ts` | the resolve-and-mint helper the grep gate keeps out of `components/` |
| `tuglaws/menus.md` | the order block's `[Send it]` line, and a paragraph in *Copy names its noun* recording the rule — the atom copy is not a session's alone, it is what an atom-inserting entity offers |

A pleasant consequence, unasked for: the composer's own editor passes no
`codeSessionStore`, so it drops the insert item — an atom already in the prompt
has nowhere to be inserted. `Copy as Atom` has no such objection and will be
offered there, which is the first way to duplicate a placed chip.

## Tests

- `tugdeck/src/lib/annotator/__tests__/registry.test.ts` — the file-kind label
  list, the url/email pair (`url` gains a row, `email` must not), the session
  facts cases, and the "every kind offers to send its value back" loop, which
  asserts the **action** rather than the label and so passes untouched. The
  natural new test is the rule itself: for every kind, *offers `Copy as Atom`
  iff its insert label says Atom* — one loop that cannot be satisfied by an
  inconsistent menu.
- `tugdeck/src/lib/annotator/__tests__/` — a unit test per promoted kind that
  `atomSegmentFor` and `payloadForAtom` round-trip, which is what the directory
  separator rule and the link label rule need pinned.
- `tests/app-test/at0346-annotation-atom-and-entity.test.ts` — two literal
  `"Insert into Prompt"` assertions (case 1's `insertLabel`, case 2's
  mention-chip `labels`). Case 1 is the home for the new claim end to end:
  `Copy as Atom` on a file in the transcript, paste into the prompt, a chip
  with the canonical `data-atom-value`. That file already drives the real
  pasteboard bridge.
- `tugdeck/src/components/tugways/__tests__/native-verb-claims.test.ts` — no
  change expected; a new menu-only copy verb is what that guard wants.
- `at0225` asserts `Insert into Prompt` for a **slash command**, which the rule
  leaves alone — and is therefore the regression that proves the rule discriminates.

## Risks

- **Browser mode.** No native bridge, so `writeCopyClipboard` falls back to
  `text/plain` — the path, the URL, the citation. Honest, and the same
  degradation the session atom already takes. Nothing to guard.
- **A relative mention value.** An `@` mention's file atom value is relative to
  the project root (`lib/atom-file-path.ts`); the payload behind the chip is
  resolved absolute before the menu sees it. The copy carries what the payload
  carries — absolute — so a paste into a card bound to a *different* project
  still names the right file. The corollary is that copy-then-paste inside one
  card converts a relative chip to an absolute one, which is invisible and
  harmless but should be said out loud once.
- **`link` is a new minter.** Everything downstream of a `link` atom —
  `buildWirePayload`, `paste-transforms`, the chip renderer — already handles
  the type, but only fixtures have exercised it. The round-trip test above is
  what stops that from being discovered at submit time.
