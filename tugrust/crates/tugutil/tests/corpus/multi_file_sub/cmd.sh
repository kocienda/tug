sed -i '' 's/\.list_exchanges(\("[a-z0-9]*"\))/.list_exchanges_since(\1, None)/g' tugrust/crates/tugcast/src/shell_ledger.rs tugrust/crates/tugcast/src/feeds/shell.rs
