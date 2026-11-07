# Supply

[![ci](https://github.com/chipsforbeer/near-supply-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chipsforbeer/near-supply-mcp/actions/workflows/ci.yml)

Purchasing and inventory records that an AI assistant works through, and supplier payments in USDC
on NEAR that the assistant can only make for orders a human approved. Built at NEAR HACKATHON
(November 2026).

Two MCP servers, one repository:

| part | what it does | NEAR |
|---|---|---|
| **Supply server** (repo root: `src/`, `bridge/`) | A company's purchasing records: stock, bills of materials, specs, suppliers and contacts, RFQs, quotes, purchase orders, approvals, documents, a wiki and an audit log. Several companies share one server; each sees only its own data. | None. It never holds keys or moves money; it issues the approved payment instruction and records the outcome. |
| **Payment MCP** ([`payment-mcp/`](payment-mcp/README.md)) | Pays purchase orders a human approved, within its own limits, and records the outcome on the order. | USDC on NEAR: privately on mainnet through NEAR Confidential Intents (1Click API), or publicly on testnet (NEP-141 `ft_transfer`). |

## The problem

A small manufacturer or food producer buys from dozens of suppliers. What is in stock, which
supplier quoted what, whether a delivery met spec and who approved an order mostly live in email
threads, spreadsheets and people's heads. An AI assistant can now do much of that work: notice low
stock, write RFQs, read the replies, compare quotes against specs and raise the order. A company
cannot let it while two things are missing:

1. **Records the assistant cannot get wrong.** Exact unit and pack conversions, stock that adds up,
   company isolation, permissions, and a reason for every change.
2. **Payments the assistant cannot misdirect.** Supplier emails and PDFs are written by outsiders and
   can carry prompt injections ("our bank details have changed"). Whatever the assistant reads, money
   must go only to the payout account an approver set, for an order a human approved, within limits.
   Paying suppliers on a public chain also shows competitors whom you buy from and at what price.

## How it works

```text
 Claude (app or Claude Code) or Codex  + your mail MCP + web search
   ├── supply MCP (src/)           a human approves POs and sets supplier payout accounts here
   └── payment MCP (payment-mcp/)  Claude passes ONLY a po_id
          1. fetches the approved payment instruction from the supply server itself
             (its own sign-in, read+write, never approve)
          2. checks it against its own limits (token allowlist, currency, caps, balance, receiver exists)
          3. signs, saves the hash, sends, waits for finality
          4. records paid + the reference on the PO
          ├── mainnet: Confidential Intents transfer, payer's private balance → supplier's private balance
          └── testnet: NEP-141 ft_transfer of Circle USDC (public)
```

- **Claude never handles the payee or the amount.** A prompt-injected assistant can ask to pay an
  order, but only an order a human approved, to the payout account an approver set, up to the
  approved amount and the payment MCP's own caps.
- **The payment side cannot approve.** It refuses and revokes a session that was granted `approve`.
  Approving orders and changing payout accounts stay with a human in the supply server.
- **Never paying twice.** Every attempt is a state machine in a local SQLite ledger; the signed
  transaction and its hash are saved before broadcasting, and a crash at any point resumes without a
  second payment. Details: [payment-mcp/README.md](payment-mcp/README.md).
- **Code mode.** The supply MCP has two tools, `search` and `execute`. Claude writes a few lines of
  JavaScript that run in a QuickJS WebAssembly sandbox with no network, files or credentials, and
  call any of its 80 operations: `api.call('low_stock_report', { site_code: 'MAIN' })`.
- **Reasons.** Every call and change carries a short reason written by the AI, kept in an
  append-only audit log; every change to a record is kept with its values before and after.

## How NEAR is used

| NEAR feature | code | used for |
|---|---|---|
| NEAR Intents 1Click API | `payment-mcp/src/rails/intents.ts`, `confidential.ts`, `fund.ts` | Quotes for a confidential-to-confidential transfer of the exact PO amount; submitting the signed intent; status; deposit addresses for funding. A quote that would deliver less than the full amount is refused. |
| Confidential Intents (`intents.far`, mainnet) | `payment-mcp/src/rails/confidential.ts` | Each PO is paid from the payer's confidential USDC balance to the supplier's. Amount and payee do not appear on the public chain, so supplier prices stay private. |
| NEP-413 signed messages | `payment-mcp/src/rails/intents.ts` | The intent is signed only if it is exactly one `transfer`, from the payer, of the PO amount, to the quote's deposit address, on `intents.far`, with a future deadline. Its hash is computed and saved before submitting; the nonce is single-use, so a re-submit cannot pay twice. |
| NEP-141 `ft_transfer` (testnet) | `payment-mcp/src/rails/public-near.ts` | The public rail: Circle USDC with memo `PO <code>`. A transaction counts as dropped only when the chain proves it expired. |
| NEP-145 storage | `payment-mcp/src/rails/public-near.ts` | The payer registers the receiver's storage, so suppliers need no NEAR for gas. Receivers that do not exist are refused (tokens sent there would be lost). |
| Implicit accounts | `payment-mcp/src/wallet.ts` | `wallet_create` makes the payer wallet; its key stays in a local `0600` file and is never shown to Claude. |
| Cross-chain funding via 1Click | `payment-mcp/src/fund.ts` | `wallet_fund` returns a one-off deposit address: USDC sent from Base, Arbitrum, Ethereum, Optimism, Polygon, Avalanche C-Chain or Solana arrives in the payer's confidential balance. Recipient and refund target are both checked to be the payer's own balance. |
| Public RPC (FastNEAR) | `payment-mcp/src/config.ts` | Balances, account checks, transaction status. |

## Try it

No hosted server is needed. Everything runs on your machine against a local demo supply server
with its own database, holding two fictional companies, *Northbeck Metalworks* and *Lark Hill
Foods*. You need Node 24, and Docker or your own Postgres 15 or newer
([without Docker](#without-docker-your-own-postgres)).

| step | needs | you see |
|---|---|---|
| [1. Tests](#1-tests) | Node, Docker or your own Postgres | 93 payment MCP tests and 202 supply server tests pass |
| [2. Full flow, simulated chain](#2-the-whole-purchase-to-payment-flow-chain-simulated) | Node, Docker or your own Postgres | an owner approves an order, the payment MCP pays it and records it on the order; a double payment and five kinds of bad payment are refused |
| [3. A real NEAR payment](#3-check-a-real-payment-this-project-made) | curl, Node | a testnet payment this project made, read from the chain |
| [4. With Claude Code](#4-with-claude-code) | Claude Code, Docker or your own Postgres | low stock → RFQ → quotes checked against spec → approved PO → delivery received |
| [5. Real testnet payment](#5-real-payment-on-near-testnet) | free testnet accounts, testnet USDC from a web faucet | a real `ft_transfer`, checked on chain, in the receiver's balance and on the PO |
| [6. Real mainnet payment](#6-private-payment-on-near-mainnet-real-money) | 0.50 USDC, a free 1Click API key | a confidential payment, checked from every side |

[CI](.github/workflows/ci.yml) runs steps 1 and 2 on every push.

### 1. Tests

Unit tests of the payment MCP need no network, keys or accounts:

```bash
cd payment-mcp
npm ci --ignore-scripts && npm run typecheck && npm test
# ℹ tests 93 … ℹ pass 93: amounts, policy checks, payment states with simulated crashes, both rails, set-up
cd ..
```

Supply server tests need a throwaway Postgres 15:

```bash
npm ci --ignore-scripts
npm run test:db:up        # Postgres 15 in Docker on 127.0.0.1:55432, data in memory
npm run typecheck && npm test
# ℹ tests 202 … ℹ pass 202
npm run test:db:down
```

They include `test/e2e/demo-flow.test.ts`, the walkthrough of step 4 driven through the real bridge
and sign-in, and `test/e2e/cross-company.test.ts`, which calls every operation as one company with
another company's ids and checks each is refused exactly like a made-up id, with nothing leaked or
changed. Without Docker, point the tests at any throwaway Postgres 15 or newer (tested on 15, 16,
17 and 18) as a superuser:
`PG_SUPERUSER_URL=postgres://postgres:<password>@127.0.0.1:5432/postgres npm test`. They create
their own roles and drop and recreate the database `sim_test`.

### 2. The whole purchase-to-payment flow, chain simulated

```bash
sh scripts/e2e-local.sh     # or: npm run e2e:local
```

It starts the demo supply server (`docker compose up --build -d`: Postgres and the server on
http://127.0.0.1:8790), reads the demo keys from its log, and runs
`payment-mcp/test/e2e/local-sim.test.ts`. Everything is real except the NEAR chain, which is
simulated in memory: sign-in with the demo keys, the owner approving, the payment MCP's own session
without approve, the supply server's payment instruction and record, the payment MCP's checks,
ledger and state machine.

```text
✔ the payment side is signed in without approve, and cannot approve an order
✔ pays an approved PO and records the same reference on it; paying again is refused
✔ a lost response after the transfer landed: recorded once, never paid twice
✔ refused, nothing sent: above our per-payment cap
✔ refused, nothing sent: payout account does not exist
✔ refused, nothing sent: mainnet account on the testnet rail
✔ refused, nothing sent: token not on the allowlist
✔ unapproved PO: the supply server refuses to instruct, nothing is sent
```

The same tests on real NEAR testnet are step 5. A smoke check of the supply server through the real
bridge, the way Claude Code connects:

```bash
SMOKE_KEY=$(docker compose logs --no-color app | awk '/owner@northbeck-metalworks/ { k = $NF } END { print k }') \
  npm run smoke -- --server http://127.0.0.1:8790
# PASS  tools: execute, search
# PASS  search: 80 operations in the catalogue
# PASS  execute: signed in to Northbeck Metalworks with read, write, approve; … 1 items below reorder
# …
# All smoke checks passed.
```

`docker compose down -v` stops the demo and deletes its data. The demo keys are printed only on the
first start of a fresh database, so start over that way if you lose them.

### Without Docker: your own Postgres

The demo supply server for steps 2, 4 and 5 also runs straight from this clone against your own
database: any Postgres 15 or newer that you can reach as a superuser, such as a local install
(tested on 15, 16, 17 and 18). Create the server's three roles and its database once:

```bash
psql "postgres://postgres:<password>@127.0.0.1:5432/postgres" \
  -v owner_password=demo-only-owner -v app_password=demo-only-app -v read_password=demo-only-read \
  -v dbname=supplier_inventory -f docker/roles.sql
```

Then start the server with Node 24. Every setting is an environment variable, checked at start-up
(`src/config.ts`):

```bash
npm ci --ignore-scripts
export PUBLIC_ORIGIN=http://127.0.0.1:8790 HMAC_SECRET=demo-only-hmac-secret-not-for-production-0001 \
  DATABASE_URL_OWNER=postgres://sim_owner:demo-only-owner@127.0.0.1:5432/supplier_inventory \
  DATABASE_URL_APP=postgres://sim_app:demo-only-app@127.0.0.1:5432/supplier_inventory \
  DATABASE_URL_READ=postgres://sim_read:demo-only-read@127.0.0.1:5432/supplier_inventory
npm run migrate                    # Applied: 001_core.sql, … 017_document_locations.sql
npm run -s seed > demo-keys.txt    # the two fictional companies and their four demo keys, shown once
npm start &                        # supplier-inventory listening on 127.0.0.1:8790 …
```

and run step 2's checks against it:

```bash
SMOKE_KEY=$(awk '/owner@northbeck/ { print $NF }' demo-keys.txt) \
  npm run smoke -- --server http://127.0.0.1:8790          # … All smoke checks passed.
cd payment-mcp && npm ci --ignore-scripts
SUPPLY_OWNER_KEY=$(awk '/owner@northbeck/ { print $NF }' ../demo-keys.txt) \
SUPPLY_BUYER_KEY=$(awk '/buyer@northbeck/ { print $NF }' ../demo-keys.txt) \
  npm run test:e2e:sim                                       # ℹ tests 8 … ℹ pass 8
```

For step 4, the Northbeck owner key is in `demo-keys.txt` (gitignored). To start over:

```bash
psql "postgres://postgres:<password>@127.0.0.1:5432/postgres" \
  -c 'DROP DATABASE IF EXISTS supplier_inventory WITH (FORCE)' -c 'DROP ROLE IF EXISTS sim_owner, sim_app, sim_read'
```

### 3. Check a real payment this project made

On 2026-11-03 the payment MCP paid order PO-0001 of the local demo on NEAR testnet: 5.90 USDC from
`boringpayments.testnet` to `boring-mill.testnet`, both accounts created for this project.

- Explorer: https://testnet.nearblocks.io/txns/HssCXwz9x4zoRvd7vNPCzoYHAQmi2BBSFkqE4qWKgnmW
- From the chain. Use an archival RPC: regular nodes keep only the last few days.

```bash
curl -s https://archival-rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"HssCXwz9x4zoRvd7vNPCzoYHAQmi2BBSFkqE4qWKgnmW","sender_account_id":"boringpayments.testnet","wait_until":"NONE"}}' \
  | node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8")).result, t = r.transaction, f = t.actions[0].FunctionCall; console.log(t.signer_id, "->", t.receiver_id, f.method_name, Buffer.from(f.args, "base64").toString(), Object.keys(r.status)[0])'
# boringpayments.testnet -> 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af ft_transfer
#   {"receiver_id":"boring-mill.testnet","amount":"5900000","memo":"PO PO-0001"} SuccessValue
```

`3e2210e1…b8af` is Circle's USDC on NEAR testnet, with 6 decimals: 5900000 is 5.90 USDC. Payments on
the confidential rail do not appear on the public chain at all, by design; step 6 makes one.

### 4. With Claude Code

```bash
docker compose up --build -d && docker compose logs app   # the demo keys are printed once
npm run sample-docs                                        # the sample supplier replies used below
claude mcp add --transport http supply http://127.0.0.1:8790/mcp
```

On the first call a sign-in page opens in your browser; paste the **Northbeck owner** key there. To
retry dropped connections on a flaky network, connect through the local bridge instead:

```bash
claude mcp add supply -- node $PWD/bridge/main.ts --server http://127.0.0.1:8790
```

or, for Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.supply]
command = "node"
args = ["/path/to/near-supply-mcp/bridge/main.ts", "--server", "http://127.0.0.1:8790"]
tool_timeout_sec = 300
```

The bridge keeps its tokens in the operating system's credential store, or in a file with
`--token-store file --token-file <path>`.

Then give Claude these one at a time:

1. *"Read our company rules, then tell me what is running low."* The 1.5 mm stainless sheet is below
   its reorder point after two months of production runs; the report suggests "2 x bundle of 20 sheets".
2. *"Find another supplier for that sheet, then send an RFQ to them and our current stockholder."*
   Claude checks for duplicates, adds the new supplier and contact, creates the RFQ and logs each
   email. (With a mail MCP connected it sends them from your mailbox.)
3. *"Both replied. Read sample-docs/quote-example-mill-direct.pdf and
   sample-docs/quote-example-stainless-stockholders.pdf, keep them, record the quotes, check them
   against the spec and compare."* The stockholder offers 1.4 mm sheet with a 2.2 test report; the
   spec and the company rules ask for 1.5 mm with a 3.1 mill certificate, so Claude records that
   verdict and the comparison keeps only the mill offer, with landed cost per kg including freight.
4. *"Raise a purchase order with Mill Direct and approve it up to 4,300 USD. Their payout account is
   mill-direct.testnet."* Approving and setting payout accounts need the approve permission. Paying
   is the payment MCP's job (steps 2, 5 and 6); with its default per-payment cap of 50 it would
   refuse a 4,300 USD order.
5. *"The delivery came with sample-docs/mill-cert-heat-5531-77.pdf. Receive it into QC, check the
   certificate, and if it passes release the lot and move it to A-01."* Stock is back to OK.
6. *"What did you change today, and why?"* The audit log lists every call with its reason.

Then sign in with a Lark Hill Foods key and ask for the stainless sheet, the RFQ or Mill Direct:
nothing comes back, because each company sees only its own records.

### 5. Real payment on NEAR testnet

Free, but it needs testnet USDC from Circle's faucet, which is a web form. Each run spends 0.50
testnet USDC. With the demo from step 2 or 4 running:

```bash
cd payment-mcp && npm ci --ignore-scripts
node scripts/testnet-account.ts <payer>.testnet --env      # funded by the testnet faucet helper; key → .env.local
node scripts/testnet-account.ts <supplier>.testnet --file  # the supplier's key stays in ~/.config
# Get testnet USDC for <payer>.testnet at https://faucet.circle.com (NEAR Testnet, 20 USDC every 2 hours)
export SUPPLY_OWNER_KEY=… SUPPLY_BUYER_KEY=…               # the Northbeck keys from `docker compose logs app`
RECEIVER_ACCOUNT=<supplier>.testnet npm run test:e2e
```

It pays one approved PO and checks the payment from three sides: on chain (receiver, amount, memo,
final status), in the receiver's balance, and on the PO (`paid` with the same tx hash). Paying again
is refused. Four more orders are refused with nothing sent (above the cap, payout account missing,
mainnet account, token not allowed), and an unapproved order is refused by the supply server.

### 6. Private payment on NEAR mainnet (real money)

Pays one 0.50 USD PO from the local demo through Confidential Intents and checks it from every
side: both confidential balances moved by exactly 0.50, 1Click reports `SUCCESS` with no public NEAR
transaction, and the PO is `paid` with the intent hash. A second order above the cap must be refused
with nothing moved. It needs a mainnet payer holding USDC and a 1Click API key (free at
[partners.near-intents.org](https://partners.near-intents.org/), key type "1Click API"). See
[payment-mcp/README.md](payment-mcp/README.md#live-payment-on-mainnet-real-money).

## Use it day to day

- **Claude app, no terminal:** the payment MCP installs as a Claude desktop extension
  (`npm run pack:mcpb` in `payment-mcp/`). Set-up happens in the chat: `payment_setup_check` walks
  through `wallet_create`, `payment_sign_in` and `wallet_fund`. See
  [payment-mcp/README.md](payment-mcp/README.md#install-in-the-claude-app-no-terminal).
- **Claude Code or Codex:** add both servers as in step 4 and the
  [payment MCP's own instructions](payment-mcp/README.md#use-it-from-claude-code).
- **Your own server:** `npm run migrate`, `npm run admin -- help` (companies, users, keys),
  `npm start`. Every setting is an environment variable, checked at start-up (`src/config.ts`); the
  three database roles are in `docker/roles.sql`.

## Safety model

- **Company isolation in the database.** Every company table has Postgres row-level security,
  forced for every role the server uses at runtime; the company comes only from the signed-in
  session.
- **Sandbox.** Code from Claude runs in QuickJS compiled to WebAssembly, a fresh instance per run,
  with only `api.spec` and `api.call`, and limits on code size, time, memory, calls and result size.
- **Permissions.** Keys carry read, write and approve scopes. Approving purchase orders and setting
  payout accounts need approve; the payment MCP never has it.
- **Sign-in.** Standard MCP OAuth with PKCE, loopback redirects only, one-hour access tokens,
  refresh-token rotation with reuse detection. Keys are typed on the sign-in page, never into the
  chat, and stored only as keyed hashes.
- **Raw SQL.** `sql_query` parses the query with the real Postgres parser, accepts only a single
  SELECT over reviewed tables and functions, and runs the regenerated query as a read-only role.
- **Supplier content is data.** Emails, PDFs and web pages from suppliers are never instructions.
  The payment MCP takes only a `po_id`, and the damage any one call can do is bounded by the user's
  permissions.
- **Payment checks.** Before money moves: the instruction is for the requested PO; the payout
  account is on the rail's network and exists; the token is allowlisted (Circle USDC) and matches the
  PO currency exactly, with no FX; the amount is within the approved maximum, the per-payment cap and
  the daily cap; it converts to token units exactly; the balance covers it. A refusal sends nothing
  and records `failed` on the PO with the reason.

## Limits

- The caps are enforced by the payment MCP, not by a contract. The hard limit is what the payer hot
  wallet holds, so keep only working capital in it. (A NEAR function-call access key cannot attach
  the 1 yoctoNEAR that `ft_transfer` requires, so the key cannot be restricted that way.)
- The public rail is public: payer, receiver, amount and memo are visible to anyone. That is fine
  for a testnet demo and is why real orders use the confidential rail.
- Confidential means hidden from the public, not from everyone: the operators of the confidential
  shard and 1Click see the transfers. Access to Confidential Intents is at NEAR Intents' discretion.
- Supplier replies in the demo are sample PDFs. In real use they come from your mailbox through a
  mail MCP; the supply server does not send email itself.
- Whether a quote or a delivery is good is Claude's judgement, recorded with its reasoning; there is
  no rule engine. Low-stock checks run when asked; there is no scheduler.
- One supply server and one database; no high availability. One payer per payment MCP process.

## Built with

Libraries (versions as locked in `package-lock.json` and `payment-mcp/package-lock.json`):

| package | version | used for |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.1 | MCP servers and client, OAuth helpers (both parts) |
| `near-api-js` | 7.4.0 | NEAR keys, signing, transactions and RPC (payment MCP) |
| `zod` | 4.6.7 | schemas and JSON Schema (both parts) |
| `express` | 5.3.0 | HTTP server |
| `express-rate-limit` | 8.7.1 | sign-in throttling |
| `pg` | 8.23.1 | Postgres driver |
| `libpg-query` | 15.6.3 | the real Postgres 15 parser (WebAssembly), to vet `sql_query` |
| `pgsql-deparser` | 15.1.1 | regenerates vetted SQL from its parse tree |
| `quickjs-emscripten` | 0.32.0 | WebAssembly sandbox for code mode |
| `@napi-rs/keyring` | 2.1.2 | bridge token storage in the OS credential store |
| `node:sqlite` | built into Node | the payment ledger |
| `typescript` (dev) | 7.0.2 | type-checking only; Node 24 runs the TypeScript directly |
| `esbuild` (build) | 0.28.2 | bundles the Claude desktop extension (`payment-mcp/scripts/pack-mcpb.sh`) |
| `@anthropic-ai/mcpb` (build) | 2.1.2 | validates and packs the desktop extension |

Services: NEAR Intents 1Click API (`https://1click.chaindefuser.com`, partner key), FastNEAR public
RPC (testnet and mainnet), the NEAR testnet account helper (`payment-mcp/scripts/testnet-account.ts`),
Circle's testnet USDC faucet, NearBlocks for explorer links. Docker images `postgres:15` and
`node:24-slim`; GitHub Actions for CI.

## AI use

Most of the code, tests and documentation were written with AI coding agents, Claude Code
(Anthropic's Claude models) and Codex (OpenAI), under the team's direction, from a design spec and
implementation plan that were also drafted with AI. The payment MCP's working-repository commits
carry `Co-Authored-By: Claude` trailers; the import commit here squashes that history. The product itself calls no AI model: it is two MCP servers that
an AI assistant uses.

## Hackathon scope

Everything in this repository was written for NEAR HACKATHON, starting 2026-11-02; there is no
earlier product and no code from another chain. Development happened in two private working
repositories, one for each part. This repository starts with a clean import of both as of
2026-11-07, without the hosted deployment's configuration. The later commits add this README, the
license, the local demo files, the simulated-chain e2e test and CI.

**Other project by a team member (Q-015).** [chipsforbeer](https://github.com/chipsforbeer), on this
team, also built [Logline](https://github.com/chipsforbeer/loglines) at NEAR HACKATHON as a solo
project: prediction markets on on-chain metrics, settled on NEAR. It is a separate submission, and
the two projects share no code.

## Repository layout

```text
src/                supply server: ops/ (operations by area), mcp/ (search, execute, sandbox),
                    auth/ (OAuth, keys, sign-in page), http/, db/ (migrations), sql/ (sql_query guard),
                    domain/ (exact decimals, units, packs), guides/ (how-tos the server serves),
                    seed/ (the two fictional demo companies)
bridge/             optional local stdio bridge for Claude Code and Codex: retries, OS credential store
payment-mcp/        the payment MCP, its own package: src/pay.ts (flow), src/policy.ts (checks),
                    src/rails/ (public NEP-141, Confidential Intents, 1Click), src/ledger.ts,
                    manifest.json (Claude desktop extension); see payment-mcp/README.md
docker/  Dockerfile  docker-compose.yml   the local demo (fictional data)
docker-compose.test.yml                   Postgres for npm test
scripts/            e2e-local.sh, smoke test, sample supplier PDFs, privacy scan
test/               supply server tests: unit, integration and end to end
.github/workflows/  CI: both test suites and the simulated-chain e2e
```

All companies, people, addresses and domains in the seeds, samples and tests are fictional
(`example.com`, `example.test`).

## License

[MIT](LICENSE)
