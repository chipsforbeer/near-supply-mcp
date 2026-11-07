#!/bin/sh
# Container start: migrate, optionally load the fictional demo data, then serve.
set -eu
NODE="node --disable-warning=ExperimentalWarning"
$NODE src/db/migrate-cli.ts
if [ "${SEED:-0}" = "1" ]; then
  if ! $NODE src/seed/seed.ts; then
    echo "Demo data was not loaded (see the message above); the server starts with what is already there."
  fi
fi
echo "Local demo with fictional data. Not for production."
exec $NODE --max-old-space-size=256 src/main.ts
