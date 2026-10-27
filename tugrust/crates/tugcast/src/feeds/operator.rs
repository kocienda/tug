I can't produce a safe merge, so I'm outputting no merged file.

The BASE, OURS and THEIRS versions of `operator.rs` were all cut off partway through, at `VerbRequest::…` in BASE, `session_transcript` in OURS, and `help_outline` in THEIRS. The rest of the file, including the pipeline, the prompts and the tests, is missing. It's also the part where both sides' changes interact. A merged file written from the partial text would silently drop code.

The overlapping hunks I could see are straightforward:
- **Imports:** keep both sides'. OURS adds `PromptLedger`, `FactCursor`, `HistorySource`, `ListOrder` and `SessionState`. THEIRS adds `help_docs::{self, HelpDoc, HelpUnit}`.
- **`OperatorContext`:** keep OURS's `prompt_ledger` and `session_index_path` fields and THEIRS's `docs_dir`.
- **`VERB_NAMES` and `dispatch`:** keep OURS's `session.transcript` and THEIRS's `help.outline`, `help.read` and `help.search`.
- **Constants and function bodies:** keep THEIRS's `HELP_*` constants and help verbs, and OURS's paging, history and transcript functions.
- **Tests and prompts:** the verb-count assertions and the retrieval prompt can't be merged without seeing them.

If you resend the three versions in full, or give me read access to the conflicted file, I'll produce the complete merged file.