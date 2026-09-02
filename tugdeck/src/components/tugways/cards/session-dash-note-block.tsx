/**
 * Registration for a dash run's quiet lines — the `$`-route rows the server
 * derives from the dash-log ([P12]). The row's command is *rendered from the
 * record* by tugcast's `command_for_line` (`dash step <name> done`,
 * `dash create <name>`, `dash mark <name> built`, `dash commit <name>`), never
 * echoed from an invocation, so the bare `dash` head is the synthetic tell: a
 * command a user actually typed spells `tugtool dash …`.
 *
 * No bespoke rendering — the generic block already shows the verb-shaped
 * command and the sentence beside it. What this registration supplies is the
 * **attribution**: the wheel runs the dash, so the run's gestures speak in the
 * wheel's voice, the same as the arc's terminal receipt — not the shell's,
 * which ran nothing.
 */
import { registerCommandBlock } from "./session-command-block-registry";
import { ShellExchangeBlock } from "./shell-exchange-block";

const DASH_NOTE_COMMAND = /^dash (create|step|mark|commit)\s+\S+/;

function matchesDashNote(command: string): boolean {
  return DASH_NOTE_COMMAND.test(command);
}

// Registration is a side effect of importing this module — the import sits
// beside the receipt blocks' in `session-card-transcript.tsx`.
registerCommandBlock("dash-note", matchesDashNote, ShellExchangeBlock, {
  attribution: "wheel",
});
