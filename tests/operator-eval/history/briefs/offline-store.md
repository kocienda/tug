# The offline store

Harbor has to open and show everything a person has already seen with no network at all.

## What we decided

The store is one SQLite file per account, in write-ahead-log mode, with a single writer task. The schema is gated on `PRAGMA user_version` with a list of numbered migrations, and a migration that fails leaves the old file in place and starts the app read-only.

## What we set aside

Postgres, bundled or remote, was rejected. A server process on a laptop is one more thing to fail at launch, and remote storage is exactly what is missing when the store is needed.

## Sync

The server wins on a conflict over metadata, and the newer edit wins over a note's body, with the loser kept as a sibling revision so nothing is ever dropped.
