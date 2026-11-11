# Getting started with Tug

With setup done, Claude Code is installed and you are logged in. This is a short walk through the loop you will use to get work done in Tug: **prompt**, **monitor**, **review**, and, once you are happy, **commit**. It takes a few minutes, and you can follow along in a session card as you read.

The [feature guide](features.md) describes every part of the app, the [recipes](recipes.md) say how to do one thing at a time, and the [glossary](glossary.md) defines the words. This card is always at Help ▸ Getting Started.

## Open a session card

Everything starts with a **session card**. Setup opened your first one. For another, press ⌘N, or choose File ▸ New Session, pick a project directory, and you have a session card backed by Claude Code.

A session card gathers your prompts, Claude Code's responses, your git interactions, simple shell commands and more into one scrolling document, in the order they happened.

## Send a prompt

Type a request into the prompt editor at the bottom of the card. Something small is fine for a first try: ask for a calculator program in C (or your favorite language).

Return starts a new line, and ⇧Return (Shift-Return) sends the prompt. That makes a prompt of several lines easy to compose. If you would rather have Return send, Settings (⌘,) swaps the two.

Text you find yourself typing again can live in the **Jots** sidebar, which ⌃⌘J shows. ⌘J saves a new jot, and dragging one into the prompt editor puts its text in your prompt.

## Watch it work

The session card shows its content as one scrolling document. Every command, every file edit and every separate action the AI takes in response to your request is in its own block, which you can open and look at if you are interested.

At the top of the card, the dot grows and pulses blue for as long as the session is working. It shrinks back and stops pulsing when the session finishes. Beside the dot, Tug narrates what the session is doing, and the same strip carries the card's other controls.

## Run a second session

Press ⌘N again, pick the same project, and a second session runs alongside the first. Tug lays the cards out for you, so you never have to drag windows around. When you do want a different arrangement, the Layout card (⌃⌘L) has the controls for moving cards and arranging them as you wish.

## Review the changes

When a session is done, review what it did. Press ⌃⌘C on its card to show the **Changes** tab.

Tug tracks which session made each change, so the tab shows only this session's work, even with two sessions running on one checkout in one directory. Every file is listed with its diff, and you can read through as much of it as you wish.

## Commit

With the Changes tab showing, the prompt editor is the commit message editor. Press ⌃⌘M and Tug drafts a commit message from the diff, which you can edit.

Press **Commit**, and a receipt for the commit appears in the transcript. The second session's work is still there, waiting for its own commit.

## Where to go next

That is the basic loop for getting things done in Tug: prompt, monitor, review, commit. There is much more to the app:

- [Tug Help](features.md) describes each part of the app in turn, with its controls and keyboard chords.
- [How Do I…](recipes.md) answers one task at a time.
- The [glossary](glossary.md) defines every word Tug uses.
- Help ▸ Keyboard Shortcuts & Commands lists every chord and slash command.
