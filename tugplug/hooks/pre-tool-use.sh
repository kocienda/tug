#!/bin/sh
# The plugin's one PreToolUse hook. Every decision — auto-approving the
# plugin's skills and the read-only Bash prefixes, denying a Bash command whose
# file operations the change ledger cannot read — is computed by
# `tugtool hook pre-tool-use`, which reads the hook payload from stdin and
# prints the decision. This wrapper only finds the binary.
#
# It depends on nothing the app bundle does not ship: no jq, no tool on the
# user's PATH. `tugtool` is looked for first on PATH (the app puts its own
# Contents/MacOS there for every child), then next to the plugin inside the
# bundle, then under TUG_BUNDLE_PATH. When none of those holds a binary the
# hook says so through a systemMessage, which Claude Code shows the user, and
# falls through to the normal permission flow — a missing tool is a visible
# fact, never a silently disabled gate.

find_tugtool() {
  if command -v tugtool >/dev/null 2>&1; then
    command -v tugtool
    return 0
  fi
  # Contents/Resources/tugplug → Contents/MacOS, by string, so a plugin dir
  # reached through a symlink still resolves inside the bundle it sits in.
  plugin_root=${CLAUDE_PLUGIN_ROOT:-}
  contents=${plugin_root%/*/*}
  for candidate in \
    "$contents/MacOS/tugtool" \
    "${TUG_BUNDLE_PATH:-}/Contents/MacOS/tugtool"
  do
    case "$candidate" in /*) ;; *) continue ;; esac
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

TUGTOOL=$(find_tugtool) || {
  cat >/dev/null
  printf '%s\n' '{"systemMessage":"Tug: tugtool was not found on PATH, beside the plugin, or under TUG_BUNDLE_PATH — the plugin hooks (skill auto-approval and the file-ops gate) are inactive for this call."}'
  exit 0
}

exec "$TUGTOOL" hook pre-tool-use
