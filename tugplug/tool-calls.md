# What a tool call reports

Every tool call is rendered as a block the user reads, and for a shell command the **exit status is the only thing the block has to go on**. Non-zero paints it red. The card cannot know what you meant by the command, so the meaning has to be in the command itself.

**Never write a call whose expected answer is a non-zero exit.** The usual shape is a probe chained onto a real query with `&&`:

```bash
tugtool brief dir --json && ls briefs/some-name.md   # red when the name is free — which was the good news
```

The `ls` failing *is* the answer being sought. Because it is last in the chain its status becomes the whole call's, so the block goes red over a call that did exactly what it set out to do.

Write the probe so its verdict cannot become the call's:

```bash
test -e briefs/some-name.md && echo TAKEN || echo FREE
ls briefs/some-name.md 2>/dev/null || true
tugtool brief dir --json; ls briefs/some-name.md     # `;` sequences; `&&` declares a dependency
```

Better still, do not ask twice. When a command already carries the answer — `tugtool brief dir --json` reports `exists` — read it from the result you already have rather than bolting a second check onto it.

Reserve `&&` for a genuine dependency, where the second command is pointless if the first failed. That is the case where red is true.

The reason is not tidiness. A red block that turns out to mean nothing teaches the reader to skim past red, and the next one will be real.
