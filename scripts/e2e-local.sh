#!/bin/sh
# The purchase-to-payment flow end to end on this machine, with no NEAR account, key or funds:
#   1. starts the local demo supply server (docker compose: Postgres + server, fictional companies),
#   2. reads the demo keys it printed on its first start,
#   3. runs payment-mcp/test/e2e/local-sim.test.ts: real sign-in, approval, payment instruction,
#      policy checks, ledger and payment record; only the NEAR chain is simulated in memory.
# Needs Docker, Node 24 and curl. Re-runs reuse the running demo; `docker compose down -v` starts over.
# The same flow on real NEAR testnet is `npm run test:e2e` in payment-mcp/ (needs testnet USDC).
set -eu
cd "$(dirname "$0")/.."

docker compose up --build -d
echo "Waiting for the demo server on http://127.0.0.1:8790 ..."
i=0
until curl -sf http://127.0.0.1:8790/healthz >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 90 ]; then
    docker compose logs app >&2
    echo "The demo server did not start." >&2
    exit 1
  fi
  sleep 2
done

log=$(docker compose logs --no-color app 2>/dev/null)
SUPPLY_OWNER_KEY=$(printf '%s\n' "$log" | awk '/owner@northbeck-metalworks\.example\.test/ { k = $NF } END { print k }')
SUPPLY_BUYER_KEY=$(printf '%s\n' "$log" | awk '/buyer@northbeck-metalworks\.example\.test/ { k = $NF } END { print k }')
if [ -z "$SUPPLY_OWNER_KEY" ] || [ -z "$SUPPLY_BUYER_KEY" ]; then
  echo "No demo keys in this container's log: they are printed only on the first start of a fresh database." >&2
  echo "Start over with: docker compose down -v && sh scripts/e2e-local.sh" >&2
  exit 1
fi
export SUPPLY_OWNER_KEY SUPPLY_BUYER_KEY

cd payment-mcp
[ -d node_modules ] || npm ci --ignore-scripts --no-audit --no-fund
npm run test:e2e:sim
