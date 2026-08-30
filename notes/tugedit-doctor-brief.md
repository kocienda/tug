A `tugtool file edit` program failed in a live session. The evidence carries the failure class (`usage`, `parse`, `resolve`, or `write`), the rendered report the caller already read, how many ops resolved out of how many, the files the program named, and the program text itself.

First decide whose fault it is: the caller's (a stale address, a wrong literal, shell-idiom quoting like `'\''` inside an edit-program string) or the tool's (a refusal that misleads, a grammar gap, a report that buries the repair, a resolution the tool could plausibly have made). Read the program against the current bytes of the files it names before judging — the report says what refused, but only the file says whether the caller's address was ever right.

If the caller was simply wrong and the report told them so clearly, say that in the headline and stage nothing.

If the tool could have done better — a clearer message, a smarter resolution, a missing capability, a sharper example in the refusal — implement it in `tugrust/crates/tugedit-core` and `tugrust/crates/tugtool`, with tests, as commits on this dash. The workspace treats warnings as errors, so `cargo clippy -p tugedit-core -p tugtool` and `cargo nextest run -p tugedit-core -p tugtool` must be green before any commit. Say in the headline what you changed and why this failure motivated it.
