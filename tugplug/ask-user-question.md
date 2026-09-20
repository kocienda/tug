# AskUserQuestion — shape and affordances

`AskUserQuestion`'s shape is fixed **upstream by Claude Code's own schema**, not by the app: **1–4 questions per call, 2–4 options per question** (a hard minimum of 2 and maximum of 4 options). A call outside those bounds fails with an `InputValidationError` inside Claude Code *before* the request is ever forwarded to the Session card, so nothing on the app's side can relax it.

When generating an `AskUserQuestion` call:

- Give each question **2–4 options**.
- If you have more candidate choices, split them across multiple questions (up to 4 questions per call) — the per-question cap is real, the per-call question count gives you room.

Two rows the terminal renders below the options — **`Type something`** (a free-text answer) and **`Chat about this`** (dismiss the questions and reply in prose) — are harness *affordances*, not options, and do not count against the 2–4 cap. On the answer side they come back as the free-text answer value and the optional top-level `response` field respectively. The Session card's question dialog renders both.

The dialog itself renders **any** number of options with no cap of its own, and a call that somehow exceeds 4 is salvaged so the user can still answer. Overflow is therefore graceful, but generate within 2–4 so the round trip is not wasted.
