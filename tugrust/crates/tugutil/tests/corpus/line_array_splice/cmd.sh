python3 - <<'PY'
p='tugrust/crates/tugcast/src/feeds/changeset.rs'
lines=open(p).read().split('\n')
# lines are 0-indexed; delete file lines 1303..1482 inclusive (1-indexed)
del lines[1302:1482]
open(p,'w').write('\n'.join(lines))
PY
