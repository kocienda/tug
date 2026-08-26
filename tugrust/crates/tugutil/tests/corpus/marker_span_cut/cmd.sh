python3 - <<'PY'
import re, pathlib
p = pathlib.Path("tugapp/Sources/MainWindow.swift")
s = p.read_text()

# 1. the replyLocalModel helper
start = s.index("    /// Hand a local-model answer back to the web layer.")
end = s.index("    private func escapeForJS(_ str: String) -> String {")
s = s[:start] + s[end:]

# 2. the localModel message-handler case
start = s.index('        case "localModel":')
end = s.index('        case "clipboardRead":')
s = s[:start] + s[end:]

# 3. registration + teardown
s = s.replace('        contentController.add(self, name: "localModel")\n', "")
s = s.replace('        contentController.removeScriptMessageHandler(forName: "localModel")\n', "")
p.write_text(s)
print("MainWindow.swift rewritten")
PY