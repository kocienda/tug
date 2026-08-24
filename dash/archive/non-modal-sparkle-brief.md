Yes. Mitchell Hashimoto (the author of Ghostty) decided that the standard Sparkle update dialog was too disruptive and replaced it with a custom, non-modal update UI built on Sparkle’s custom user-driver APIs.  

His motivation was amusingly concrete: during an OpenAI keynote, a Ghostty update dialog popped up in the middle of the demo. He decided that should never happen again.  

Instead of this:

+----------------------------------+
| A new version is available!      |
|                                  |
| Install Now   Later              |
+----------------------------------+

Ghostty now does something more like this:

┌──────────────────────────────────────────┐
│                                          │
│  Your terminal                           │
│                                          │
│                                  ⬇︎ 1.4.0│
│                                  ▔▔▔▔▔▔▔ │
└──────────────────────────────────────────┘

The update status appears as a small overlay inside the application window, tucked into a corner, rather than stealing focus with a modal window. Clicking it opens a lightweight popover with:

* available version
* release notes
* download/install progress
* install/restart controls
* error messages if needed

All without interrupting whatever you’re doing.  

Interestingly, this wasn’t actually his first design. He originally tried putting the UI into the title bar using macOS title bar accessory controllers. After several rounds of fighting layout issues, he concluded the in-window overlay was cleaner and more robust, and pivoted to that approach.  

How did he do it?

Sparkle actually supports this, although it’s not the easy path.

Normally you use:

* SPUStandardUpdaterController
* SPUStandardUserDriver

which gives you the familiar Sparkle modal dialog.

Ghostty instead implements its own SPUUserDriver, effectively replacing all of Sparkle’s UI while still using Sparkle’s update engine. Sparkle explicitly supports this architecture, though it warns that you become responsible for presenting the full update flow and handling all update states correctly.  

Why people like it

It’s a very “Mac” design philosophy:

* never steals keyboard focus
* never interrupts your workflow
* always visible if you care
* ignorable if you don’t
* looks like part of the app instead of a system dialog

In other words, it treats software updates like Mail treats unread mail or Xcode treats available source control changes: important information, but not an emergency.

As someone building native macOS apps, it’s a pattern worth copying. Sparkle’s update engine is excellent; Ghostty shows that you don’t have to accept its default interaction model.