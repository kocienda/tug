# The work statement: a fence that declares queued arcs

**Purpose:** A session that lays out a run of arcs says so only in prose, so the list exists in the transcript and nowhere else. This brief gives the model one parseable form for that statement, which the Session card draws and Tug reads into the cycle with no act from the user.

---

## Purpose {#purpose}

The steward session `liven/rotund-plaid` stated its list of arcs six times, as numbered lines of `/arc <name> @<brief>` in its answers. The user ran the arcs by copying each line. Nothing else ever read the list:

> The system must be able, somehow, to recognize this session created all these briefs and gave me the commands for all these arcs.

Asked whether Tug should read the list from the transcript or the model should record it:

> It should read the list from the transcript. We need to be supple and absorb the content from the user as it's made.

Asked whether a changed list should replace the old one:

> We can't create a garbage pile. We need to exercise some editorial control and have the UI reflect the changes in the work as it happens. We can't leave crud or turds behind.

Asked whether the statement should be a fence or prose lines, the user chose the fence.

This brief is the second of three and is written from `briefs/work-records-brief.md`, which adds the queued arc and the verb that queues one. `briefs/cycle-keeper-brief.md` is the third.

---

## Evidence {#evidence}

**[F01] The list is the progression, and it changed as the work did.** Across 21 turns the steward's list went from eight arcs to four, twelve, fourteen and fifteen, then to eleven remaining. Arcs were added at the end, an arc that landed left the list, and the order moved twice. Read from `tugtool session show 81acbce8-ec2c-4686-877f-c889f083424f`. **(verified)**

**[F02] Nothing scans an assistant's answer for arc commands.** The one detector near it, `arc_door_target` in `tugrust/crates/tugcast/src/feeds/agent_supervisor/mod.rs`, reads a user prompt of the form `/arc <name>` and nothing else. **(verified, by a delegated search)**

**[F03] The settled answer is available where a turn ends.** A finished assistant block rides the session's output as an `assistant_text` frame with its full text, and the turn-end edge in `tugrust/crates/tugcast/src/feeds/agent_supervisor/mod.rs` already ticks four followers. The session digest keeps only the first hundred characters of an answer, so it cannot serve as the source. **(verified, by a delegated search)**

**[F04] The house already has the pattern.** `tugchart`, `tugdiagram` and `tugrun` are fences the model writes as a small spec, the card draws, and a compiler checks. Their contracts ship in the plugin and ride every session's prompt. **(verified)**

**[F05] The brief skill already prints one arc command, as inline code.** `tugplug/skills/brief/SKILL.md` ends its hand-off with `/arc <slug> @<path>` in backticks, as an object a surface may offer to run or copy. **(verified)**

**[F06] Starting an arc from a surface is deferred, and the deferral is the user's.** `tuglaws/cycles.md` records Start as drawn and not built, with the finding that a Start press fills a prompt and never sends. **(verified)**

---

## Decisions {#decisions}

**[B01] The statement is a fence named `tugarcs`.** A fenced block of that language in an answer carries a small spec: the arcs in the order they are meant to run, each with its name, its brief's path, and a short label of its own. It may also give a wait that is not simply the arc before. The fence is the contract. It joins the family in [F04], with its own name, its contract in the plugin, and a check the model runs before writing it.

**[B02] Bare command lines in prose are read as a fallback.** Lines of `/arc <name> @<path>` in an answer are read as the same statement, in the order written, with the label taken from the arc's name. A session that never learned the fence still has its list absorbed. The single hand-off line the brief skill prints ([F05]) is a statement of one.

**[B03] Tug reads the statement when the answer ends, and the user does nothing.** tugcast parses the settled answer at the turn-end edge ([F03]), records the statement as a fact naming the session and the turn, and queues the arcs through the core's verb. The model does not run a verb to record its own list.

**[B04] A session's newest statement replaces that session's earlier one.** When the same session states a list again for the same cycle, its queued arcs that no arc has opened are made to match the new list: added, reordered and removed. An entry whose arc is running or has landed is never touched. Nothing is struck through or kept as a ghost; the statement's fact is the only trace of a list that was replaced. This is the editorial control the user asked for, and it is mechanical because it concerns one session's own words.

**[B05] The cycle is found through the briefs the statement names.** A queued arc goes on the cycle that holds its brief. When some of the statement's briefs are on a cycle and others are on none, the others join the first one's cycle, since a session listed them together. When none is on a cycle, the arcs are held as stated and placed nowhere until something grounds them: the door, when one of them opens, or the keeper. The chain requires a sketch for every entry, and this brief invents none.

**[B06] The card draws the fence as the run it declares.** Each arc is a row: its label, its brief as a file atom, and how it stands now, read live from the cycle. The command for an arc that has not opened is shown as an inline object the user can copy, as the brief skill's line is. An arc that has since landed shows that, so an old answer still reads true. Rejected: a Start control on each row, which waits on the deferral in [F06].

**[B07] A statement in a private session is drawn and not recorded.** The fence still renders. No fact is written and nothing is queued, the same refusal the ledger already makes.

**[B08] The fence is checked before it is written.** A compile step answers the model the way the diagram compiler does: clean, drawn with warnings, or not drawable. A statement naming a brief that is not on disk, or a name that is not a valid arc name, is a warning the model sees before the answer exists.

---

## Non-goals {#non-goals}

- **Starting an arc from the fence.** Deferred by the user until the cycle surfaces settle ([F06]).
- **Reading a list out of a user's prompt.** The user sometimes pasted the list back. The statement is the model's; a list in a prompt is the user quoting it.
- **Resolving two sessions that state different lists for one cycle.** That needs judgment and is the keeper's.
- **Writing a sketch for arcs that have none.** Also the keeper's. This brief holds such arcs unplaced.
- **Changing how `/arc` is typed.** The command line and what the door does with it are unchanged.

---

## Exit {#exit}

**An arc**, opened after the work-records arc has landed, since it calls that arc's verbs:

- The fence's spec, its contract in the plugin beside the chart and diagram contracts, and its compile check.
- The reader at the turn-end edge: the fence first, then the prose fallback, the fact, and the call that queues.
- The replace rule for a session's own earlier statement, with tests over the liven sequence of six lists.
- The card's rendering of the fence, live against the cycle store.
- The brief skill's hand-off line left as it is, and read as a statement of one.
