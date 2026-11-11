# Getting started with Tug

With setup done, Claude Code is installed and you are logged in. This is a short walk through the loop you will use to get work done in Tug: **prompt**, **monitor**, **review**, and, once you are happy, **commit**. It takes a few minutes, and you can follow along in a session card as you read.

The [feature guide](features.md) describes every part of the app, the *How do I...* [recipes](recipes.md) say how to do one thing at a time, and the [glossary](glossary.md) defines the terms the app and this documentation uses. To see this card again, choose Help > Getting Started.

Each step says what to click or choose, with its keyboard shortcut in parentheses. A shortcut such as Control-Command-C means: hold down the Control and Command keys and press C.

## Open a session card

Everything starts with a **session card**. Setup opened your first one. For another, choose File > New Session (or press Command-N), pick a project directory, and you have a session card backed by Claude Code.

A session card gathers your prompts, Claude Code's responses, your git interactions, simple shell commands and more into one scrolling document, in the order they happened.

## Send a prompt

Type a request into the prompt editor at the bottom of the card. Something small is fine for a first try: ask for a calculator program in C (or your favorite language).

Click the send button at the end of the prompt editor to send the prompt (or press Shift-Return). Return alone starts a new line, which makes a prompt of several lines easy to compose. If you would rather have Return send, choose Tug > Settings (or press Command-Comma) and swap the two under Prompt Editor.

Text you find yourself typing again can live in the **Jots** sidebar, which its row in the View menu shows (or press Control-Command-J). Choose File > New Jot (or press Command-J) to save a new one, and drag a jot into the prompt editor to put its text in your prompt.

## Watch it work

The session card shows its content as one scrolling document. Every command, every file edit and every separate action the AI takes in response to your request is in its own block, which you can click to open and look at if you are interested.

At the top of the card, the dot grows and pulses blue for as long as the session is working. It shrinks back and stops pulsing when the session finishes. Beside the dot, Tug narrates what the session is doing, and the same strip carries the card's other controls.

## Run a second session

Choose File > New Session again (or press Command-N), pick the same project, and a second session runs alongside the first. Tug lays the cards out for you, so you never have to drag windows around. When you do want a different arrangement, the Layout card, which its row in the View menu shows (or press Control-Command-L), has the controls for moving cards and arranging them as you wish.

## Review the changes

When a session is done, review what it did. Click the **Changes** tab on its card, or choose Session > Show Session Changes (or press Control-Command-C).

Tug tracks which session made each change, so the tab shows only this session's work, even with two sessions running on one checkout in one directory. Every file is listed with its diff, and you can read through as much of it as you wish.

## Commit

With the Changes tab showing, the prompt editor is the commit message editor. Click the pencil-sparkles button beside it (or press Control-Command-M) and Tug drafts a commit message from the diff, which you can edit.

Click **Commit**, and a receipt for the commit appears in the transcript. The second session's work is still there, waiting for its own commit.

## Where to go next

That is the basic loop for getting things done in Tug: prompt, monitor, review, commit. There is much more to the app:

- [Tug Help](features.md) describes each part of the app in turn, with its controls and keyboard chords.
- [How Do I…](recipes.md) answers one task at a time.
- The [glossary](glossary.md) defines every word Tug uses.
- Choose Help > Keyboard Shortcuts & Commands for a list of every keyboard shortcut and slash command.
