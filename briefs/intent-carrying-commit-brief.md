# The intent-carrying commit

**Purpose:** Every deck mutation that moves a frame lands by a rule the settle reconstructs from a string diff after the fact, and each new gesture has to be re-litigated against that reconstruction. The mutation should say how it lands.

---

## Purpose {#purpose}

Five rounds of sidebar-card and rail defects landed in one week, each a different subsystem's assumption failing at the same seam — what happens when a hand touches a rail member. The last of them: "when I click a partially-obscured sidebar card it *snaps* to its fully-revealed position instead of animating to its new position. UGH. All this code seems like it's a horrid hack job. Whack-a-mole on every detail fix. So hard to get decent fit and finish this way. What can we do about this? This needs to get under better control."

The immediate cut was fixed by splitting `data-pointer-owned` out of `data-gesture` (`a7004f9a6`). This brief is about why the mole keeps surfacing, and what makes it stop.

---

## Evidence {#evidence}

**[F01] Motion is decided by a diff, not by the gesture that caused it** — `arrangementSignature` (`tugdeck/src/components/chrome/deck-canvas.tsx`, ~line 423) is a string over every input the imposer reads: pane ids, slots, widths, bullseye, each rail's side/width/mode/members/seams/offset, layout mode, flow offset, each column's members/seams/offset. Its comment block runs some sixty lines explaining term by term why each is present. The settle arms when the string changes and tweens whatever moved. It can therefore answer *did anything move?* but structurally not *should this cross or cut?* — that depends on why it moved, which the mutation knew and discarded before the subscriber ran. **(verified, read out of the code)**

**[F02] Intent is reconstructed downstream through negative rules** — the settle recovers "how should this land" from proxies: a frame wearing `data-pointer-owned` is skipped; a rail or column whose mode flipped gets a fade plan by comparing against `prevRailModesRef`/`prevColumnModesRef`; reduced motion skips measurement; a frame with no First rect is classed as arriving unless it wears the pointer mark, in which case it is mid-landing. Each rule is a patch that recovers intent the commit already had. The `data-gesture` cut was one of these proxies reading the wrong thing. **(verified)**

**[F03] Per-frame writers avoid the settle by staying out of the store, and say so** — the scroll gestures (`applyScroll`) write the offset custom property per frame and commit once at the end, and the doctrine in `tuglaws/pane-model.md` explains why: the offset is a signature term, so a per-frame commit would arm a settle on every frame. The store cannot be told "this write is a cut"; the only way to say it is not to write the store. Three comments in the tree (`deck-manager.ts:3182`, `deck-manager-store.ts:101`, `drop-zones.ts:326`, `tug-pane.tsx:3024`) all carry the same warning. **(verified)**

**[F04] The commit already names its author but not its landing** — `DeckManager.notify(caller)` takes the mutating method's name and carries it into `deck-trace`'s `store-notify` record for the census; inside a batch the first caller wins the tag. The settle subscribes with a no-argument callback (`store.subscribe(arm)`) and learns nothing from it. The channel for a commit to describe itself exists for telemetry and is not read for motion. **(verified)**

**[F05] The cut detector was blind to the cut it exists to find, for the same reason the settle caused it** — `tugdeck/src/lib/cut-detector.ts` filtered out any jump on a frame carrying the gesture mark, and `at0450-imposer-cut-census.test.ts` dispatches all of its gestures programmatically, so no census entry has ever had a frame under a real press. A probe that sampled the frame across a native release showed the clicked member at its final `top` in the first sample inside the `pointerup`, with `data-gesture` still on, while its neighbour glided 210px over ~385ms. The detector's filter now reads `data-pointer-owned`, but the census still presses nothing. **(verified, reproduced in the harness)**

**[F06] "Was that a click?" is decided twice, with the same threshold typed twice** — `DRAG_MOVE_THRESHOLD_PX = 3` in `tug-pane.tsx` latches the pane's drag, and `CLICK_TRAVEL_PX = 3` in `gesture-interpreter.ts` decides whether a release reveals. The interpreter's comment acknowledges the pane's constant and mirrors it by hand. Two components independently interpret one pointer stream with one number copied between them. **(verified)**

**[F07] Three listeners act on one `pointerup` in an order nothing declares** — the interpreter (document, capture), the pane (frame, target), and the settle (store subscriber, synchronous inside whichever of the first two commits). The order is fixed by listener phase and DOM depth. The reveal fix put a commit into the earliest of the three, which was the only place that knew the gesture ended without travel, and thereby committed geometry while the DOM still said the frame was self-driving. **(verified)**

---

## Decisions {#decisions}

**[B01] A mutation declares how it lands; the signature keeps detecting what moved.** The store gains a landing on the commit — `cross` (the default, what every arrangement change does today), `cut` (the frame is already drawn there; a per-frame writer catching the store up), and `land` (a drop: the dragged frame is carried by its own landing, everything else crosses). The settle's `arm` reads the landing rather than inferring it. `arrangementSignature` stays exactly as it is, as the detector of *whether* frames moved; it stops being asked *how*. This is the smallest change that ends the re-litigation: a new gesture declares its landing, and the settle has no rule to learn about it.

**[B02] The landing rides the channel `notify(caller)` already is.** `notify` becomes `notify(caller, landing = "cross")`, the subscriber receives the landing, and `deck-trace`'s `store-notify` record carries it beside the caller. No new bus, no new store field, no React state ([L06]). Inside a batch the outermost commit's landing wins, matching the first-caller rule the tag already has, and a batch mixing `cut` and `cross` resolves to `cross` — crossing a frame that is already there is a no-op tween, cutting a frame that is not is the defect.

**[B03] `cut` retires the "stay out of the store" rule for per-frame writers.** `applyScroll` and the autoscroll may keep writing the property per frame for cost reasons, but the reason they *must* is gone: a per-frame commit with `landing: "cut"` arms nothing. The four comments in [F03] are rewritten to say the offset commits with `cut`, not that it cannot commit. Whether the per-frame writers actually move into the store is a cost question for the arc, not a correctness one, and this brief does not decide it.

**[B04] The click verdict has one author.** `DRAG_MOVE_THRESHOLD_PX` moves to a leaf module both `tug-pane.tsx` and `gesture-interpreter.ts` import, and `CLICK_TRAVEL_PX` is deleted. This is the whole of the change to the interpreter's press tracking; unifying the two press trackers into one is out of scope (Non-goals).

**[B05] The cut census presses a mouse.** `at0450` gains pointer-driven entries alongside its programmatic ones — at minimum the rail click-reveal, a drop landing, and a seam release — each with its own allowed-cut count, zero from the start. The detector reports a jump under a pointer-owned frame as its own kind rather than dropping it, so the census can see a self-positioned frame that cut. This is the part that turns the defect class from something the user's eyes find into something the suite fails on first.

**[B06] The landing is a term of the trace, and a settle that disagrees with its landing is a census failure.** A `cross` commit that armed no settle, or a `cut` commit that armed one, is recorded by `deck-trace` and counted by the census. The doctrine already prints "1 settle arm(s) (0 unarmed)"; the landing gives that line something to check against.

---

## Open Questions {#open-questions}

- **Whether `land` is a landing or a `cross` with an exempt frame.** A drop's dragged frame is carried by `zone-drop-landing` and skipped by the settle via `data-pointer-owned`; every other frame crosses. That may be `cross` plus the existing mark rather than a third value. Read `tug-pane.tsx`'s zone-drop commit path when the arc opens; if the mark alone suffices, `land` is not introduced.
- **Whether the per-frame writers move into the store under `cut`.** [B03] makes it legal; the perf notes in `deck-canvas.tsx` (the commit-during-animation cost, `arc/jul30-perf-brief.md#s5-imposer`) say why it may still be unwise. Measure before moving them.

---

## Non-goals {#non-goals}

- **One gesture engine owning press/travel/release for the whole deck.** [F06] and [F07] argue for it, but it is a rewrite of `tug-pane.tsx`'s drag machine and the interpreter together, and this brief's problem is solved without it. [B04] takes the one duplicated number; the rest waits for its own brief.
- **Replacing `arrangementSignature` with a change list.** The signature is well built and its comment block is the best record of what moves frames. The defect is not that it detects too much; it is that it is asked a question it cannot answer. It stays.
- **A CSS transition on the offset properties.** The offsets are unregistered custom properties read through `calc()` in `top`/`bottom`; a transition would re-run layout per frame for every member, which is the cost FLIP exists to avoid (`deck-canvas.tsx`, the FLIP comment). Rejected on the doctrine already in the tree.
- **Any change to what a click or a drag does.** The press moves nothing, the click's release reveals, the drag's drop answers for itself (`dad96ebd9`). This brief is about how those land, not what they do.

---

## Exit {#exit}

**An arc.** The shape, in the order it must land:

1. The landing type and `notify(caller, landing)` in `deck-manager.ts` and `deck-manager-store.ts`, threaded into the subscriber and into `deck-trace`'s `store-notify` record. Every existing call site defaults to `cross`; behaviour is unchanged at this step.
2. The settle's `arm` reads the landing and declines on `cut`. `commitScroll` and the autoscroll's commit pass `cut`. The `revealCard` and `setFlowOffset`-from-a-chip paths stay `cross`. [F03]'s four comments rewritten.
3. `DRAG_MOVE_THRESHOLD_PX` to a leaf module; `CLICK_TRAVEL_PX` deleted.
4. The census: pointer-driven entries, the detector's new record kind for a self-positioned cut, and the landing-vs-arm check from [B06].

Steps 1–2 must land together or the trace lies; 3 and 4 are independent of each other and of 1–2.
