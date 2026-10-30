<!-- brief-skeleton v1 -->

# One chart door: `/viz` takes any request, and Claude Code's `dataviz` skill is off in Tug

**Purpose:** Claude Code ships a bundled `dataviz` skill whose description claims every chart in every medium, and Tug ships its own chart system behind `/viz`. Two skills answer "chart this", only one of them can draw in a Session card, and nothing today says which one runs. Tug should have one chart door, and it should take any request, not just the twelve recipes.

---

## Purpose {#purpose}

Two `/viz` runs in this session drew their charts, and the user then asked: "is the dataviz skill ours or does that come from Claude Code?" It is Claude Code's. The user's reaction was "what does theirs do that ours doesn't? ... Did we just make something overlapping and confusing?" and, once the comparison was on the table: "disable theirs. Let's not have any confusion about what skill runs and where."

Two more asks followed in the same conversation. First, "our /viz skill should also accept *any* free-form request to visualize data, not just our built-in recipes. It should be nimble and flexible." Second, whether `/dataviz` could still be recognised and hand over to our skill. The answer settled was yes: an unlisted redirect, and `/viz` callable by the model as well as by the user.

The two ideas from the bundled skill worth keeping, hover and a computed colorblind check, were asked for in the same breath: "Borrow the two best ideas. do this."

---

## Evidence {#evidence}

**[F01] `dataviz` is Claude Code's, not Tug's** — its description text is inside the Claude Code binary (`~/.local/share/claude/versions/2.1.311`) and it loads from `/private/tmp/claude-501/bundled-skills/2.1.311/…/dataviz`. Nothing in this checkout provides it: `tugplug/skills/` holds `arc arc-audit arc-devise arc-implement arc-review brief draft viz`, `.claude/skills/` holds only `spike-card`, and neither `tugplug/`, `tuglaws/` nor `CLAUDE.md` mentions it. **(verified)**

**[F02] `dataviz` is written instructions and one script; it draws nothing** — its `SKILL.md` is a seven-step procedure (pick the form, assign colour by job, validate the palette, mark specs, a hover layer, an accessibility pass, look at it) plus reference files and `scripts/validate_palette.js`, a palette validator. It has no renderer, no chart language and no access to project data; it tells the model how to hand-write a chart in whatever medium is at hand. **(verified, read)**

**[F03] Its trigger collides with Tug's chart guidance** — the skill's description says to read it "BEFORE writing the first line of chart code" for "ANY chart ... in ANY output medium", inline SVG included, while `tugplug/graphics.md` says the `tugchart` fence is the only chart to make in a Session card: "no SVG by hand, no ASCII bars, no Mermaid, no image." A bare "chart this" can load the bundled skill and pull the model toward hand-drawn output. `/viz` has sidestepped it so far only because it is user-invoked and goes straight to the recipes. **(verified)**

**[F04] A per-skill override removes it cleanly** — Claude Code's settings schema carries `skillOverrides`, "per-skill listing overrides keyed by skill name", with values `on`, `name-only`, `user-invocable-only`, `off`; `off` "hides it from both" the model and the user. A scratch run with `--settings '{"skillOverrides":{"dataviz":"off"}}'` removed `dataviz` from both the `skills` and `slash_commands` lists of the init message and left every other bundled skill in place (31 skills against a baseline of 32; `simplify` still present). Typing `/dataviz` under the override returns one line: `Skill "dataviz" is disabled via skillOverrides. Remove the override from your settings to run it.` **(verified, scratch run)**

**[F05] The blunter switch is wrong for this** — `disableBundledSkills` / `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` removes every bundled skill and workflow, and hides the built-in slash commands from the model. That takes `simplify`, `code-review` and the rest with it. **(verified, settings schema text)**

**[F06] Tug sets neither today** — `tugcode/src/spawn-config.ts` builds the Claude Code argument list (`--plugin-dir`, `--permission-mode`, `--append-system-prompt`, `--add-dir`, `--model`) and passes no `--settings`. The tugcast worker spawn in `tugrust/crates/tugcast/src/shared_agent.rs` runs with `--disallowedTools *`, so no skill can act there regardless. **(verified)**

**[F07] `/viz` is user-only and recipe-shaped** — `tugplug/skills/viz/SKILL.md` carries `disable-model-invocation: true` and `allowed-tools: Bash, Read`. Its body is: list the recipes, pick one, run it with `--json`, draw it once; its "no recipe answers" branch reads only `tugtool log|diff|test last|apptest history|report gaps --json` and writes one `tugchart` fence. A request about a CSV, a file, or command output has no route through it. **(verified)**

**[F08] The chart compiler has no hover** — no tooltip, crosshair, pointer or mouse handling exists in `tugdeck/crates/tuggraphics/src`, `tugdeck/src/lib/chart/` or `chart-block.tsx` (grep over those trees). The forms are `area bar bullet dots heat histogram line spans sparkline`; there is no scatter. **(verified)**

**[F09] Every chart already has its data beside it** — `tuggraphics/src/chart/table.rs` builds a `ChartTable` (caption, head, rows) from the spec alone, `render-chart.ts` builds the `<table>` alternative from it, and transcript Find counts its text. The deck has a tooltip primitive, `tugdeck/src/components/tugways/tug-tooltip.tsx`. Hover has both a data source and a surface to borrow. **(verified)**

**[F10] Tug already runs a colorblind check on the chart series, a weaker one than the bundled skill's** — `tugdeck/src/components/tugways/theme-accessibility.ts` lists the seven adjacent chart-series pairs (`series1`–`series2` … `series7`–`series8`) in `CVD_SEMANTIC_PAIRS`, and `checkCVDDistinguishability` simulates each deficiency and flags a pair whose luminance difference falls under `CVD_LIGHTNESS_DELTA_THRESHOLD = 0.05`. `tugdeck/scripts/audit-theme-contrast.ts` runs it headlessly over every theme and gates on the `ironclad` budget. The bundled skill's validator instead measures a perceptual colour distance in OKLab under each deficiency (a ΔE floor of 8, with 6–8 allowed only with a secondary encoding) and a separate normal-vision floor. I had earlier told the user Tug had no such check; that was wrong. **(verified, read)**

**[F11] Each theme currently reports one CVD warning, pair unidentified** — `bun run scripts/audit-theme-contrast.ts --quiet` prints `1 CVD warning(s)` for every theme and passes (no theme exceeds the `ironclad` budget). The per-theme output I read did not name the pair, so whether it is a chart series or a status colour is not known. **(verified count; pair not verified)**

**[F12] Slash aliasing in the deck covers local commands only** — `tugdeck/src/lib/slash-commands.ts` rewrites typed names through `LOCAL_SLASH_COMMAND_ALIASES` in `matchLocalSlashCommand`, which is how `/cd` reaches `/change-directory`; a plugin skill such as `/tugplug:viz` is not a local command and is sent to Claude Code as typed. A `/dataviz` redirect needs a small addition at the same seam. **(verified)**

**[F13] The `TUG-CHART:` door already accepts a raw drawing** — the Bash block mounts each chart with `layers="any"`, so a layer-0 program as well as a layer-1 spec renders there. A request no form fits still has an outlet inside the system. **(verified, `bash-tool-block.tsx`)**

---

## Decisions {#decisions}

**[B01] Tug turns `dataviz` off in every session it spawns, by `skillOverrides`, and nowhere else.** `tugcode/src/spawn-config.ts` adds `--settings '{"skillOverrides":{"dataviz":"off"}}'` to the Claude Code argument list. This is the per-skill switch [F04]; `disableBundledSkills` is rejected because it takes the other bundled skills with it [F05]. It rides the spawn rather than any settings file so the user's own `~/.claude` configuration and their terminal Claude are untouched, and so it holds on a project with no `.claude/` directory at all, which is what the standalone contract requires. The worker spawn in tugcast needs nothing: it already disallows every tool [F06]. Revisit if Claude Code ever makes `/viz`'s job a built-in that renders in the card.

**[B02] `/viz` is the one chart door, and it takes any request.** Its procedure becomes three rungs, taken in order: a recipe, when one answers; otherwise read the data the request names with whatever tool fits (a file, a CSV, a command's output, a figure in the transcript); then draw it as one `tugchart` fence, as the session's chart guidance describes. The "no recipe answers" branch [F07] is the seed of the second rung, widened from five `tugtool` verbs to any readable source. The skill still writes no file and never runs `tugtool chart render`. "Make me a matplotlib script" is not a `/viz` job and stays ordinary work.

**[B03] `/viz` is callable by the model.** `disable-model-invocation` comes off, and the description is rewritten as the trigger for any chart, plot or visualisation request in a Tug session, taking over the territory `dataviz` claimed [F03]. With [B01] in place that trigger has no competitor. "Chart this" in prose and `/viz` in the composer then take the same route.

**[B04] `/dataviz` is recognised and hands over to `/viz`, unlisted.** Once `/viz` takes anything [B02], somebody who types the bundled name gets what they meant instead of an error that points at a settings file they never wrote [F04]. The rewrite happens in the deck at submission, beside the local-command aliases in `slash-commands.ts` [F12], producing the same `/tugplug:viz …` line the popup would have composed. It appears in no slash popup and no help sheet, so `/viz` is the only name anyone sees; the redirect exists for the hand that already knows the other one.

**[B05] Hover reads from the table, so it cannot disagree with the figure.** The compiler emits, per mark, an invisible hit target larger than the mark, carrying the index of its `ChartTable` row and column [F09]; the deck shows that row in the existing `tug-tooltip`. Per form: one target per bar, cell, dot, span and bullet; a column band with a crosshair on line and area, since a vertical position is what a reader asks about there; none on a sparkline, which has no title and is read at a glance. Table view stays the keyboard and screen-reader route; hover adds to it and replaces nothing. This is the bundled skill's "hover layer by default" [F02] on top of a data alternative the skill does not have.

**[B06] The series colour check becomes a perceptual distance with a normal-vision floor, and a failing series is retuned.** `checkCVDDistinguishability` gains the measure the bundled validator uses, an OKLab distance under each simulated deficiency with a floor, plus a floor under normal vision, over the same seven adjacent chart pairs [F10]. The lightness-delta check stays as it is for the status pairs. The first act is to name the one warning each theme reports [F11]; if it is a chart series, the series is re-stepped in that theme's file. `ironclad` is the reference every other theme is budgeted against and is edited only if it is the theme that fails. The audit keeps its gate: no theme may exceed the `ironclad` budget.

**[B07] The compiler gains a scatter form.** A door that takes any request will be asked for one against another within the week, and the forms list has no answer [F08]. The form takes `points` of `{x, y}` pairs per series, direct labels where they fit, and a hit target per point under [B05]. Anything stranger than that is what the layer-0 drawing door is for [F13].

**[B08] The design rules the two systems share stay enforced in the compiler, not restated in prose.** One axis, fixed series colours never cycled, status colours reserved for outcomes, direct labels, a table view: the bundled skill asks the model to apply these by hand [F02], and Tug's compiler already applies most of them. Borrowing the two ideas above does not mean importing the procedure; `tugplug/graphics.md` gains a line saying hover is there and one naming the scatter form, and nothing more.

---

## Open Questions {#open-questions}

- **Which pair is the one CVD warning each theme reports [F11]?** Reading the full, non-quiet audit output names it. If it is a status pair rather than a chart series, [B06] retunes nothing and only tightens the measure.

---

## Non-goals {#non-goals}

- **`disableBundledSkills`.** Rejected: it removes every bundled skill, not the one in the way [F05].
- **Editing the user's `~/.claude` settings or their terminal Claude.** The override is Tug's and rides Tug's spawn [B01]; a Claude run outside Tug keeps `dataviz`.
- **A second chart system, or porting the bundled skill's palette and procedure.** Tug's charts are drawn by a compiler from theme tokens; the skill's hex palette and seven-step method are for a model drawing by hand [F02], [B08].
- **Dashboards, filter rows, date-range controls, stat tiles.** The bundled skill covers them; Tug's charts are figures in a transcript, one chart per fence, and nothing here changes that.
- **A dual axis.** Both systems forbid it. Two measures are two charts.
- **File output from `/viz`.** No SVG, PNG, script or notebook is written; the figure belongs in the transcript [B02].
- **Listing `/dataviz`.** The redirect is deliberately invisible [B04]; a listed alias is a second name for the door this brief exists to make singular.

---

## Exit {#exit}

**An arc.** The first steps, in the order they must land:

1. **The override.** `spawn-config.ts` passes the `skillOverrides` setting, with a test on the argument list [B01]. This lands first because everything after it assumes no competitor.
2. **The door.** Rewrite `tugplug/skills/viz/SKILL.md` to the three rungs, drop `disable-model-invocation`, widen `allowed-tools` to what reading a file or a command needs, and rewrite the description as the trigger [B02], [B03]. `just tugplug-lint` and `just test-standalone` still pass.
3. **The redirect.** `/dataviz …` rewritten to `/tugplug:viz …` at submission in the deck, unlisted, with a unit test on the rewrite and none on the popup [B04].
4. **Scatter.** The form in `tuggraphics`, its table rows, its measure, a line in `graphics.md` [B07].
5. **Hover.** Hit targets in the compiler, the tooltip in `render-chart.ts`, an app-test that hovers a bar and reads the tooltip's text against the table [B05].
6. **Colour.** Name the warning, add the perceptual measure and the normal-vision floor, retune any failing series, keep the audit green [B06].

Steps 4 and 5 can be walked in either order; 6 is independent of both.
