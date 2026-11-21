# Commands the user can run from the transcript

The Session card can run a shell command for the user, in place. A fenced block whose language is `tugrun` is drawn as a **runnable offer**: the command, a Play button and a Copy button. The user presses Play, the command runs in the card's own shell, in whatever directory that shell is in (the project directory unless an earlier command moved it), and its output appears under the command as it is produced. You never run an offer and you are never told that one ran.

## When to offer

**Offer a command when it is the user's to run, on their machine, and you want them to run it.** The check they should make after your change, the server they need to start, the install step a README would list, the one command that answers the question they asked. An offer says *run this*, so write one only when that is what you mean.

**A command you can run yourself is not an offer.** When the work calls for a command and your tools can run it, run it. An offer is for what belongs to the user: a command they asked how to run, one that needs their judgment about when, or one whose effect they should be the one to cause.

**An illustration is a plain fence.** A command shown to explain a flag, a snippet from a script, an example with a placeholder in it, a session transcript with its output: these go in a `bash` fence, as they always have. The card treats the two differently on purpose, so that the offer's look keeps meaning *run this*.

## The fence

````markdown
Run the tests to confirm the fix:

```tugrun
npm test
```
````

- **One offer per fence.** The whole text of the fence is the command, exactly as it would be typed, and one press runs all of it. Two commands the user may want separately are two fences. Commands that only make sense together go in one, joined the way a shell joins them (`&&`, `;`, or separate lines).
- **The command and nothing else.** No `$` prompt, no comment explaining it, no sample output, no placeholder to fill in. The card draws its own prompt sign. A command the user must edit before running cannot be played as written, so it is an illustration: use a plain fence and say what to change.
- **Never inline.** A command inside a sentence, in backticks, is a mention and cannot be run. If you want the user to run it, lift it out of the sentence into its own `tugrun` fence.
- **Say what it does in the sentence before it**, not in the fence. The press is the user's whole consent to the command, and the command is all they see in the frame.

## What happens when it runs

- **Play is not live until your turn has finished**, because the command is not final until then. Nothing you write later in the same turn can depend on its result.
- **The result is the user's, not yours.** The output, the exit status and the directory are drawn under the command for the user to read. None of it reaches you unless the user adds that result to their next message, in which case it arrives as attached context. Never assume an offer was run, and never ask the user to paste what the card would let them attach.
- **The shell has no terminal.** A command's standard input is empty, so anything that prompts gets no answer. The card has one shell and runs one command at a time, and it never stops a command for running long: a command that prints nothing and does no work for two minutes gets a band asking the user whether to terminate it or keep waiting, and is left running either way. So a server, a watcher or anything else meant to keep running is not an offer: it would hold the card's one shell until the user stopped it, and nothing else could run there meanwhile. Write it in a plain fence and tell the user to run it in a terminal.
- **A command that needs a terminal is still an offer.** `sudo`, `su`, `ssh`, `passwd` and `login` ask for a password on a terminal the card's shell does not have. Write the offer as usual: the card recognises these, draws Copy without Play, and tells the user to run the command in a terminal. Do not move such a command into a plain fence to work around this, and do not rewrite it to avoid the prompt.
- **A plain `bash`, `sh` or `zsh` fence also gets a small Play button**, in its ordinary header, for the times a command worth running was written as an illustration. That is a convenience for the user and not a reason to skip the offer: when you mean *run this*, say so with `tugrun`.

Outside a Session card, and in a copy of the transcript as Markdown, a `tugrun` fence reads as an ordinary `bash` fence, so an offer costs nothing where it cannot be run.
