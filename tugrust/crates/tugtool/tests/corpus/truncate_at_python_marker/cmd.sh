python3 - <<'PY'
import re,io
p="tugdeck/src/components/tugways/keybinding-map.ts"
s=open(p).read()
start=s.index("// ---- Keybindings ----")
s=s[:start]
open(p,"w").write(s)
PY
