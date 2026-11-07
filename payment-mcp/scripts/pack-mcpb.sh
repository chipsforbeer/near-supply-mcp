#!/usr/bin/env bash
# Builds dist/near-payment-mcp.mcpb (Claude desktop extension) from a clean staging folder, so local
# files such as .env.local, the ledger or tests can never end up in the bundle.
set -euo pipefail
cd "$(dirname "$0")/.."
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
# One self-contained ES module: the app's built-in Node is an Electron utility process, so we do not
# rely on it stripping TypeScript or resolving node_modules. The app runs the FIRST manifest arg.
cp manifest.json "$stage"/
node -e 'const p=require("./package.json");require("fs").writeFileSync(process.argv[1],JSON.stringify({name:p.name,version:p.version,description:p.description,type:"module",private:true},null,2))' "$stage/package.json"
npx -y esbuild@0.28.2 src/extension.ts --bundle --platform=node --format=esm --target=node22 \
  --outfile="$stage/dist/extension.mjs" --legal-comments=none --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
mkdir -p dist
npx -y @anthropic-ai/mcpb@2.1.2 validate "$stage/manifest.json"
npx -y @anthropic-ai/mcpb@2.1.2 pack "$stage" dist/near-payment-mcp.mcpb
# refuse to ship anything that looks like a local secret file
if unzip -Z1 dist/near-payment-mcp.mcpb | grep -vE '^node_modules/' | grep -E '(^|/)\.env|\.db(-|$)|wallet-[a-z]+\.json$|^test/|\.tokens' ; then
  echo 'refusing: the bundle contains a local file' >&2; rm -f dist/near-payment-mcp.mcpb; exit 1
fi
echo "built dist/near-payment-mcp.mcpb"
