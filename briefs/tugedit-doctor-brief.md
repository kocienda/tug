A `tugtool file edit` program refused somewhere in the work that just landed. Each `edit_failed` fact carries the failure class (`usage`, `parse`, `resolve`, or `write`), the rendered report the caller already read, how many ops resolved out of how many, the files the program named, and the program text itself.

Answer one question: whose fault was it, the caller's or the tool's?

The caller's, when the program held a stale address, a literal that was never in the file, an indentation that was not the file's own, or shell-idiom quoting (`'\''`, `'"'"'`) inside an edit-program string — and the report said so plainly. Read the program against the file it named before you judge. You are standing in the landed commit, which is *after* whatever repair followed, so the bytes the program was addressing may no longer be there; the transcripts in the lineage are the one place the program and the file as it then stood sit next to each other.

The tool's, when the refusal misled, when the report buried the repair under the diagnosis, when the grammar had no way to say what the caller plainly meant, or when the resolution was one tugedit could have made and did not.

Resolve `--quiet` when the caller was simply wrong and the report told them so. A caller's mistake is not news however often it happens, and a tripwire that reports every one of them is a tripwire nobody reads.

Resolve `--awaiting` only for a tool fault, with a headline naming the class, the message the caller actually saw, and the file — one line, for somebody who saw none of this.

When the tool fault is worth repairing, add `--author` and say which behaviour should change and what the refusal should say instead. The change belongs in `tugrust/crates/tugedit-core` and `tugrust/crates/tugtool`, with a test pinning the new message or the new resolution. The workspace treats warnings as errors, so `cargo clippy -p tugedit-core -p tugtool` and `cargo nextest run -p tugedit-core -p tugtool` must be green before anything is committed.
