# Arc Supplement — Tug

*This checkout's supplement to the arc doctrine. The doctrine itself ships in the plugin, at [tugplug/doctrine/arc-work-doctrine.md](../tugplug/doctrine/arc-work-doctrine.md), with the [devise skeleton](../tugplug/skills/arc-devise/devise-skeleton.md) and the [plan review rubric](../tugplug/skills/arc-review/plan-review-rubric.md) beside the skills that read them, so an arc runs at full fidelity on any project. This file is what is true of Tug alone. `.tugtool/config.toml` declares it under `[tugtool.arc]` `doctrine`, and declares the laws below under `laws`; `tugtool arc config` reports both, and the implement, audit and review stages read them after the plugin's doctrine.*

*The test for a paragraph here is the plugin's test turned around: would it be false in a project that is not Tug? A no means it belongs in the plugin's doctrine instead.*

## Verify before every commit

**Warnings are errors.** The Rust workspace enforces `-D warnings` through `tugrust/.cargo/config.toml`, so a warning fails `cargo build` and `cargo nextest run` alike.

What a step's checkpoint comes to in this checkout:

- `bunx tsc --noEmit` for TypeScript that moved.
- Pure-logic tests for the scope that moved (`bun test <scope>`).
- `cargo nextest run` for Rust — the affected crates while iterating, the workspace on the **last step that touched Rust**.
- An app-test where the change is one only the real app can show.

The arc's ending runs what the `[[tugtool.arc.surface]]` table in `.tugtool/config.toml` declares, through `tugtool arc verify`.

## The slow layer is the app-test

An app-test launches `Tug.app`, costs a two-minute `just app-test-build` before it and tens of seconds to minutes per file, and queues machine-wide behind any other worktree's run (`tugtool host gate --name apptest`). Iterate on `tsc` and `bun test`, then build once and run the step's selection once.

- **Selection.** `just app-test-changed` derives the selection from the step's changes through each test's `@covers` lines; take the union with the step's named files.
- **History.** Every red file in the report's `Failures:` section carries a `history:` line from `tugtool apptest history`. Re-run alone only files whose history says they were green before you touched the tree; a file red at the base, which the step does not claim to fix, leaves the selection and is named in the report.
- **Instruments.** Never add a `note()` to a slow test and re-run it to read the note — a settle-frames file is about 160 seconds plus the rebuild, and one step that ran `at0622` five times to read instruments was the incident the doctrine's rule records (2026-10-05).
- **Core tier.** The core tier (`just app-test`, no arguments) runs once per arc, on the first step that changes a harness file's existing behaviour; adding a new export nobody imports yet is not that.
- **Overtime.** A file still running at the per-file budget (`TUG_APPTEST_FILE_BUDGET_SECS`, 20 s unless set) is stopped and recorded as `OVERTIME`, a red that says where it was. A run whose files all stop far past their recorded medians is a wedged machine, not a result: relaunch rather than debug them. The ledger reads a `STALLED` row — the old `WEDGED` — as neither a red nor a duration.

The how-to is [app-test-harness.md](app-test-harness.md) and the "Testing" section of the root `CLAUDE.md`.

## Test discipline

- **Real-app and browser-behavior tests** — focus, selection, event ordering, caret, portal timing, gestures — live in `tests/app-test/` and run through **`just app-test <file>`**. Never hand-roll the equivalent `TUGAPP_IN_APP_TEST=1 TUGAPP_DEBUG_PATH=… bun test …` pipeline: the recipe does the app-path query, the re-sign, the dist refresh, and the pkill, and prints a finished report ending in a `VERDICT:` line.
- **Pure-logic tests** are plain `bun:test` files with no DOM globals. Rust logic is `cargo nextest`.
- **Banned here, in addition to the doctrine's list: fake-DOM / RTL tests.** No `happy-dom`, no `jsdom` render tests, no `@testing-library/react`. There is no in-process DOM substrate; happy-dom was deleted. A test that needs `document`/`window` to express itself is either a pure function over data or an app-test. `tugtool plan lint` refuses these when a plan names them in a Tests block.
- **A body change is read in the running app before it is done.** A change to the shell, a body, the host's placement of bodies, or the harness's event delivery is not done until it has been looked at in the running app — a dev instance of the real binary with the body switch on, read through the eval door and a window capture compared against the body's own surface colour and the shell's chrome colour, never ink share. The harness has twice called such a change green while the user's deck was rough, so the test is necessary and the reading is the verdict.
- **A test of a chord or a menu command takes the app's own path.** It launches `foreground: true` so keys go through the session tap with the app active, performs menu items with `performMenuItem` so validation, the action and `sendControl` all run, and asserts the effect in the page that should have received it. Pid-mode delivery, `lab.dispatch`, DOM `keydown` synthesis and a `sendControl` from the test are not evidence for a keyboard or menu row.

## Law discipline

The laws this checkout declares under `[tugtool.arc]` `laws`:

- [tuglaws.md](tuglaws.md) — the numbered laws, `[L##]`.
- [design-decisions.md](design-decisions.md) — the numbered decisions, `[D##]`, which a plan's `[D##]` citations name.
- [pane-model.md](pane-model.md) — the Deck → Pane → Card hierarchy.
- [component-authoring.md](component-authoring.md) — the component author's checklist.

**Which code they govern.** Before writing or materially changing code under `tugdeck/src/components/tugways/` or `tugdeck/src/components/chrome/` — hooks, components, CardHost plumbing, portal and registry wiring — read all four, and name the laws the change touches in the round's commit body (e.g. "upholds [L02] via `useSyncExternalStore`; [L22] via direct store observation"). Not required for Rust, Swift, plugin, or pure documentation changes.

**The review's cross-check** names laws such as `[L02]`, `[L22]`, `[L27]`, `[L28]`, and for tugdeck / tugways work it is mandatory. A plan that moves appearance through React state, or reads external state without `useSyncExternalStore`, is wrong regardless of how well it reads.

### The Project-Law Mapping, worked: state zones

For tugdeck / tugways plans the skeleton's optional **Project-Law Mapping** is required, and here it is the **State Zone Mapping**: every piece of state the plan introduces names its zone (structure / local-data / appearance / lifecycle) and the mechanism that carries it there. The zone dictates the mechanism, and getting it wrong is the most common law violation.

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `<state>` | <zone> | CSS+DOM / useState+useRef / store + useSyncExternalStore / useLayoutEffect | [L24], [L06], [L02], [L22] |

## Stop before the join

- **The build.** This checkout's `[tugtool.arc]` `build` is `just app-debug`.
- **The join draft.** A good join message to read before writing one is `a18557090`: it says what a project can now declare, what routes through it, which boundary was held, and how it was proven, with no round list and nothing that requires having watched the arc.

## Where the rest lives

- The arc's state model, identity and binding — what `created`, `working`, `implementing`, `built`, `audited`, `draft-ready` and `joining` mean — is [arc-lifecycle.md](arc-lifecycle.md). The decisions behind the doctrine's join rules are [D139], [D142], [D144], [D147], [D149] and [D152] in [design-decisions.md](design-decisions.md).
- Retiring a slash-command spelling: an unmatched `/verb` is submitted to claude as a prompt rather than refused, so a retired spelling stays as an alias. [slash-commands.md](slash-commands.md) owns that rule, under "Retire a spelling".
- A stage that needs a decision stops rather than returning silently — the arc-level form of [L31].
