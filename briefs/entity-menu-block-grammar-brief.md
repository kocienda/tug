# Copy as Atom sits in one seat, and the block grammar holds it there

**Purpose:** `Copy as Atom` appears in a different position depending on which entity's menu you open — top of the copies on a session, bottom of five on a commit. The seat is one symptom; the cause is that the block grammar `tuglaws/menus.md` states is hand-written per kind and enforced nowhere.

---

## Purpose {#purpose}

From two screenshots of the same Git Commit receipt, one right-click on the session citation and one on the commit pill:

> I really want `Copy as Atom` to have a more consistent placement in the right-click menus for all the items that offer this as a feature across the app.

The session chip's menu opens its copy block with `Copy as Atom`. The commit pill's menu puts it last, under four hash and record copies. Both menus are correct by their own docblocks' reasoning, and neither is wrong on its own terms — there is simply no single anchor, and the two sit inches apart on one card.

---

## Evidence {#evidence}

**[F01] The registry is the single source for every menu that offers the row.** `tugdeck/src/lib/annotator/registry.ts` writes every kind's item list. The three identity menus — `tugdeck/src/components/tugways/commit-identity-menu.tsx`, `file-identity-menu.tsx`, `session-identity-menu.tsx` — each render `annotationEntryFor(kind)` through `entityMenuItems`, and `arc-row-menu.tsx` offers no atom at all. A placement change is one file, not a sweep. **(verified — read from the files)**

**[F02] The seat splits one way against six.** Surveyed across every registered kind: **(verified — read from `registry.ts` and `registry.test.ts`)**

| Kind | Menu, in order (`──` is a rule) |
|---|---|
| `file-path` | Open in Editor · Show in Finder ── Copy Path · **Copy as Atom** ── Insert Atom into Prompt |
| `url` | Copy Link · **Copy as Atom** · Insert Atom into Prompt |
| `directory` | Show in Finder · Copy Path · **Copy as Atom** · Insert Atom into Prompt |
| `image` | Open Image · Copy Name · **Copy as Atom** · Insert Atom into Prompt |
| `commit-sha` (sha only) | Open Commit ── Open Diff ── Copy Short Hash · Copy Full Hash · **Copy as Atom** · Insert Atom into Prompt |
| `commit-sha` (holds record) | Show Detail ── Open Commit ── Copy Short Hash · Copy Full Hash · Copy Commit Header · Copy Commit Record · **Copy as Atom** |
| `session` (holds record) | Show Session ── **Copy as Atom** · Copy as Citation · Copy Session ID ── Copy Description · Copy Activity Line ── Insert into Prompt |
| `session` (payload only) | **Copy as Atom** · Copy Session ID ── Insert Atom into Prompt |
| `email`, `shell-command`, `slash-command` | no atom — correct, they insert as text |

Six kinds put it last in the copy block; `session` puts it first. The two screenshots are exactly the two halves of that split.

**[F03] The law states the anchor and the session menu contradicts it deliberately.** [tuglaws/menus.md](../tuglaws/menus.md#copy-names-its-noun) fixes the copy block as `Copy <Noun> · Copy as <Format>` — atom last. `sessionMenuEntries` puts it first with its own argument in the docblock, and `registry.test.ts` pins that contradiction as an expected label list. Neither side is an accident. **(verified)**

**[F04] Nothing enforces the block grammar, so the rules disagree too.** The law's five blocks — `[Go to it] ── [Act on it] ── [Copy it] ── [Send it] ── [Standard]` — are real, but every kind hand-writes a flat array and hand-places `separatorBefore`. The result: `file-path` and `session` draw a rule before Insert; `url`, `directory`, `image` and `commit-sha` do not. `directory` and `image` draw no rule anywhere. The law is a habit reviewers keep, not an invariant the code holds — which is how the atom seat drifted, and why fixing only the session menu would leave the next kind free to drift again. **(verified)**

**[F05] The blast radius is small.** No app-test asserts a menu-item index; they assert membership or click by action id. `at0574-card-masthead-file-menu.test.ts` asserts one exact three-label list. `at0528`, `at0346`, `at0376`, `at0527`, `at0533` assert membership. The unit-level pinning is concentrated in `tugdeck/src/lib/annotator/__tests__/registry.test.ts`. **(verified — read from the test files; the selection itself has not been run)**

---

## Decisions {#decisions}

**[B01] `Copy as Atom` is the FIRST row of the `[Copy it]` block, on every kind that offers it.** The atom is the entity itself; every other copy is a projection of one of its fields, so the object leads and the fields follow. This keeps the session menu exactly as it is today — the shape the user looked at and approved — and moves the other six. It also puts a session's two `Copy as <Format>` rows together at the top of the block rather than straddling it. Revisit only if a kind appears whose atom is not the thing a reader reaches for first.

**[B02] `commit-identity-menu.tsx`'s "the first copy is the one the app writes commits as" is overturned.** That docblock argues `commit:<8>` leads the copies because it is the form the app writes commits as. Under [B01] the atom leads and `Copy Short Hash` follows it. The argument was about which *text* form leads and remains true of the text forms; it is not an argument about the object. The docblock is rewritten rather than reordered.

**[B03] The block grammar becomes structural, not a convention.** `registry.ts` gains an assembler — `buildEntityMenu({ goTo, act, copy, send })` — that takes named blocks, places every rule, and prepends the atom row whenever `atomSegmentFor(payload) !== null`. No kind writes a `separatorBefore` again, and `atomCopyEntries` disappears into the assembler. Without this, [B01] is one more convention to keep by hand and the next kind drifts the same way; [F04] is the evidence that hand-placement does not hold. `entity-menu-items.ts` keeps its leading-rule suppression unchanged — it translates, and translation is not assembly.

**[B04] The atom row's predicate stays `atomSegmentFor`, unchanged.** It is already the one predicate behind both the copy and the insert label, which is what keeps the two from disagreeing about what an entity is ([atom-menu-items-sketch.md](atom-menu-items-sketch.md)). The assembler reads it; it does not replace it. A kind promoted to atom-insert later therefore inherits the row *at the right seat*, which is what `atomCopyEntries` only half-delivered.

**[B05] `registry.test.ts` asserts the invariant across `ALL_KINDS`, not per-kind label lists.** One loop: if a menu names an atom, `Copy as Atom` is the first row of its copy region, and no menu opens with a rule. Explicit label lists survive only where the *content* is the point — the `commit-sha` record branch, `email` against `url`. Per-kind lists are what made [F03]'s contradiction look like a specification.

**[B06] The law is amended in the same change.** [tuglaws/menus.md](../tuglaws/menus.md) restates the copy block as `Copy as <Format> · Copy <Noun>` under "The order is fixed", carries [B01]'s reasoning under "Copy names its noun", and notes that the rules are assembler-placed rather than per-kind. A law that still says the old order is a second source for the next reader to find.

---

## Open Questions {#open-questions}

- **Do `directory` and `image` want the rules the assembler will give them?** Both draw no rule at all today, so assembling them to the grammar adds one or two lines to a four-row menu. This is almost certainly right — it is the point of [B03] — but it is a visible change to two menus nobody complained about, and it is worth one look in the running app before it lands.

---

## Non-goals {#non-goals}

- **Atom last, directly above the Send rule.** Considered and rejected. It would have moved only the session menu and honored [B02]'s original argument, and it puts `Copy as Atom` adjacent to `Insert Atom into Prompt` — the two rows that mint the same object. Rejected because the session menu is the one the user looked at and wanted kept, and because the object-leads-its-projections reading in [B01] is the stronger rule.
- **Atom in a block of its own, ruled off from the copies.** Considered and rejected: consistent and self-explaining, but it adds a rule to short menus — a `url`'s menu becomes three rows and two rules, which is more chrome than the distinction is worth.
- **Adding the atom row to kinds that do not offer it.** `email`, `shell-command` and `slash-command` insert as text, so an atom copy there would be a lie the menu tells. [B04] keeps the predicate that already prevents it.
- **Touching `arc-row-menu.tsx`.** An arc appears only as a row and is not in the registry by an existing decision ([tuglaws/menus.md](../tuglaws/menus.md#what-is-deliberately-not-here)). It offers no atom and none is being added.
- **Any change to what `Copy as Atom` writes.** The clipboard payload, its sidecar, and its plain flavor are settled and unaffected. This is placement only.

---

## Exit {#exit}

**An arc.** The work is one substantive file plus its law and its tests, and the shape is roughly:

1. Add `buildEntityMenu` to `tugdeck/src/lib/annotator/registry.ts` and rewrite the seven `menuEntries` functions as block declarations. `commitMenuEntries`' early return on the record branch dissolves into one conditional `copy` tail; every hand-written `separatorBefore` and `atomCopyEntries` itself go away.
2. Rewrite `registry.test.ts`'s per-kind label lists as the `ALL_KINDS` invariant of [B05], keeping content-specific lists.
3. Amend [tuglaws/menus.md](../tuglaws/menus.md) per [B06], and the docblocks in `commit-identity-menu.tsx` and `file-identity-menu.tsx`, both of which draw their menus in prose and would otherwise go stale — `commit-identity-menu.tsx`'s is the one that [B02] overturns.
4. Update `at0574-card-masthead-file-menu.test.ts`'s exact list to `Copy as Atom · Copy Path`; run `just app-test-select` to confirm nothing else pins an order.

Order matters only in that the assembler lands before the tests are rewritten against it. The open question above wants a look at a `directory` and an `image` menu in the running app before the arc joins.
