# NEAR Payment MCP

Pays approved purchase orders on NEAR, as an MCP server that the Claude app, Claude Code or Codex
works through. It is the payment half of this repository. The other half is the
[supply server](../README.md) at the repository root: a company's purchasing records, with stock,
suppliers, quotes, purchase orders and approvals. That server never holds keys or moves money. This
one does, and only for orders a human has approved.

Two rails behind one interface, both tested end to end:

- **Confidential rail (NEAR mainnet):** pays through NEAR Confidential Intents, so the amount and the
  payee do not appear on the public chain or in explorers. Supplier pricing stays private. Real
  mainnet payments of 0.50 USDC have been made and checked from both sides.
- **Public rail (NEAR testnet):** a plain NEP-141 transfer, visible to anyone. It is the free,
  runnable demo path.

## How it fits together

```text
 Claude Code / Codex / the Claude app
   ├── supply MCP  (repo root)   ← an approver approves the PO and sets the payout account
   └── payment MCP (this folder) ← Claude passes ONLY a po_id
          │  1. fetches po_payment_instruction from the supply server itself (its own sign-in)
          │  2. checks it against its own limits
          │  3. signs, saves the payment hash, sends, waits for it to settle
          │  4. records po_payment_record (paid + hash) on the PO
          ├── mainnet: Confidential Intents transfer (private balance → supplier's private balance)
          └── testnet: NEP-141 ft_transfer of Circle USDC (public)
```

**Claude never handles the payee or the amount.** Claude reads supplier emails and PDFs, and those
can contain instructions written by anyone. So the payment MCP takes only a `po_id` and fetches the
payout account, token and amount from the supply server over its own authenticated connection. A
prompt-injected Claude can ask to pay an order, but only an order that a human already approved, to
the payout account an approver set, up to the approved amount.

**The payment MCP cannot approve anything.** It signs in to the supply server asking for `read write`
only, and it refuses and revokes a session that was granted `approve`. Approving orders and changing
payout accounts stay with a human approver in the supply MCP.

## Tools

| tool | what it does |
|---|---|
| `payment_preview {po_id}` | Read-only. Shows what would be paid, to whom, on which rail, and every reason it would be refused. Changes nothing anywhere. |
| `payment_pay {po_id}` | Pays the PO in full and records the outcome on it. Safe to call again: it resumes an interrupted payment and never pays twice. |
| `payment_status {po_id}` | Every attempt for the PO, with live on-chain status and the explorer link. |
| `payment_reconcile` | Finishes payments interrupted after signing (lost responses, crashes, slow finality). Never starts a new one. |
| `wallet_balance` | Payer balances, today's committed spend, the limits. |
| `payment_setup_check` | Read-only. Checks the API key, wallet, supplier-server sign-in, balance and limits, and says what to do next. |
| `payment_sign_in` | Opens the supplier server's sign-in page in the browser for this server's own session (read+write, never approve). The key goes into that page, never the chat. |
| `wallet_create` | Creates the payer wallet (a NEAR implicit account) when there is none. The key stays in a local file and is never shown to Claude. Never replaces a wallet. |
| `wallet_fund {amount, from_chain}` | A one-off 1Click deposit address: USDC sent there from Base, Arbitrum, Ethereum, Optimism, Polygon, Avalanche or Solana arrives in the payer's **private** balance. |
| `wallet_fund_status {deposit_address}` | Where that deposit is, and the private balance. |

## Checks before any money moves

These run on every payment, after the supply server's own approval check:

- The instruction is for the PO that was asked for, on `near`.
- The payout account belongs to the rail's network: `.testnet` on testnet, `.near` or implicit on mainnet.
- The token is on the allowlist (Circle's native USDC), and its currency matches the PO currency exactly. There is no FX conversion.
- The amount is at most the approved maximum, the per-payment cap and the remaining daily cap.
- The amount converts exactly to token units. It is never rounded.
- The payer's balance covers it.
- The receiver account exists on chain. NEP-145 lets anyone register storage for an account that does not exist, and tokens sent there are lost. The payer pays the receiver's storage, so the supplier needs no NEAR for gas.

A refusal sends nothing. It records `failed` on the PO with the reason, so an approver can fix the
cause and pay again.

## Never paying twice

Every payment attempt is a row in a local SQLite ledger, one per supply server and network, under
`~/.config/near-payment-mcp/`. Each step is saved before the next side effect:

```text
instructing → instructed → signed → broadcast → settled_ok | settled_failed → recorded
                  └→ refused (checks) ────────────────────────────────────┘
instructing → aborted (the supply server refused to instruct)
```

- **The instruction is fetched with a fixed request key** (`pay:{po}:{attempt}`). If the response is
  lost, a retry gets the server's cached instruction instead of "already instructed".
- **The live PO status is checked before signing.** An instruction replayed from a stale ledger
  cannot pay an order that was already settled elsewhere.
- **The signed transaction and its hash are saved before broadcasting.** After a crash, the same
  signed transaction is sent again; it can land only once, and nothing is ever re-signed.
- **A transaction counts as dropped only when the chain proves it.** That means the latest final
  block is past the transaction's reference block plus the validity period. Any RPC error or doubt
  leaves the payment `pending`. Guessing here once recorded a landed payment as failed, which is
  covered by `test/public-near.test.ts`.
- **One payer advances one attempt at a time.** Payments and reconciliation are queued, so balance
  and daily-cap checks, signing and recording cannot race, even across different orders.

**Do not delete the ledger file while a payment is open.** Together with the PO's `payment_status`,
it is what prevents a double payment.

## The confidential rail

On mainnet, each PO is paid from the payer's **confidential balance** to the supplier's confidential
balance. Confidential Intents run on a permissioned NEAR shard (`intents.far`). It has no public RPC:
every transfer goes through NEAR Intents' 1Click API, which needs a partner API key
([partners.near-intents.org](https://partners.near-intents.org/), key type "1Click API").

One payment:

1. **Quote:** confidential → confidential, same token in and out, the exact PO amount. A quote that
   would deliver less than the full amount (a fee taken from the supplier) is refused.
2. **Check, then sign:** 1Click returns a NEP-413 message to sign. The payment MCP signs it only if it
   is exactly one `transfer`, from the payer, of exactly the PO amount of confidential USDC, to the
   quote's deposit address, on `intents.far`, with a future deadline. Anything else is refused.
3. **Save, then send:** the intent hash is computed locally and saved with the signed message
   *before* it is submitted, just like the tx hash on the public rail. The hash is what the PO's
   `payment_ref` records.
4. **Settle:** 1Click reports `SUCCESS`, `REFUNDED`, `FAILED` or in progress. A payment counts as
   dropped only when it never executed and is more than an hour past its signed deadline, after
   which the contract can no longer accept it.

Re-submitting the same signed message cannot pay twice: its nonce is single-use. This was checked on
mainnet by re-submitting a settled payment; neither balance moved.

**Funding** never moves money out of anything. `wallet_fund` only asks 1Click for a deposit address
whose recipient **and refund target** are the payer's own confidential balance (both are checked in
the quote before it is shown), and the user sends USDC there themselves, from an exchange or a wallet
they control. No NEAR wallet is needed. Cost observed on 2026-11-04: about 0.02% (5.00 USDC from Base
→ 4.999 private USDC), 20-45 s after the deposit confirms.

A payer that already holds USDC in a NEAR wallet can shield it instead, from a terminal:

```bash
npm run shield -- 1.00    # wallet USDC → NEAR Intents → the payer's confidential balance
npm run balance           # NEAR_NETWORK=mainnet npm run balance for the confidential balance
```

Both are public on the way in: anyone can see a deposit into confidential balances (on the source
chain, or as a shield on NEAR). That says nothing about which supplier is paid, or how much per order.

## Install in the Claude app (no terminal)

The Claude app runs local MCP servers as desktop extensions, with its own built-in Node, so a user
needs nothing but the app. Build the extension once (a developer does this):

```bash
npm run pack:mcpb     # → dist/near-payment-mcp.mcpb, built from a clean copy (no .env.local, ledger or tests)
```

Then, as the user:

1. **Install:** double-click `near-payment-mcp.mcpb` (or Settings → Extensions → Install extension).
   The install dialog asks for a **NEAR Intents API key** (free at partners.near-intents.org, type
   "1Click API"), the **supplier server** address and optional limits. Keys entered there are stored
   in the OS keychain by the app.
2. **Connect the supply server** in the app (a deployed server: Settings → Connectors → add
   `https://<your supply server>/mcp`) and sign in with **your own** key: you are the approver.
3. **Ask Claude to set up payments.** It runs `payment_setup_check` and walks through the next step
   each time:
   - `wallet_create`: a new NEAR account whose key stays on this computer (back up
     `~/.config/near-payment-mcp/wallet-mainnet.json`);
   - `payment_sign_in`: a browser tab opens; sign in there with the **payments** key (read+write, no
     approve), a different member from you, so the AI-driven payment side can never approve;
   - `wallet_fund`: send the exact USDC amount it shows, on the chain you chose, to the address it
     shows. Check the address in the tool result, not only in Claude's reply.
4. **Pay:** "What is running low? Order it, and pay once I approve." Claude raises the PO in the
   supply server, you approve it there, then `payment_preview` and `payment_pay`.

**Demo data for a live run.** `npm run seed:demo-brewery` loads a fictional brewery into an
**empty** company on a supply server, through its normal operations, as that company's owner.
Yeast, hops and malt end up running low, and Example Yeast Lab sells a yeast brick at 0.50 USD, paid
to `SEED_PAYOUT_ACCOUNT`. It refuses unless `SEED_COMPANY` matches the key's company and the company
is empty; see the script header for the variables.

Installing without the extension (Claude app → Settings → Developer → Edit Config) works too, but
needs Node, a clone of this repo and keys typed into a JSON file.

## Run it

You need Node 24 (23.6+ works) and npm. Run the unit tests first; they need no network, keys or
services:

```bash
npm ci --ignore-scripts
npm test            # 93 tests: amounts, checks, payment states with simulated crashes, both rails, set-up
npm run typecheck
```

### The whole flow on this machine, chain simulated

No NEAR account, key or funds. From the repository root:

```bash
sh scripts/e2e-local.sh
```

It starts the supply server's local demo (Docker), reads the demo keys from its log and runs
`test/e2e/local-sim.test.ts`: the same flow as the testnet suite below, against the real supply
server, with only the NEAR chain simulated in memory. To run the test alone against a demo that is
already up: `SUPPLY_OWNER_KEY=… SUPPLY_BUYER_KEY=… npm run test:e2e:sim`.

### Live demo on NEAR testnet

This uses the supply server's local Docker demo, which holds only fictional companies, and real
NEAR testnet. Each `npm run test:e2e` run spends 0.50 testnet USDC.

1. **Start the supply server's demo** at the repository root (Docker):
   ```bash
   docker compose up --build -d && docker compose logs app   # prints the demo keys once
   ```
   Keep the **Northbeck owner** key (the human approver) and the **Northbeck buyer** key (the
   payment MCP, which has no approve permission). The e2e test reads them from `SUPPLY_OWNER_KEY` /
   `SUPPLY_BUYER_KEY`, or from `~/.config/near-payment-mcp/local-demo-keys.txt` (the lines exactly
   as printed).
2. **Create testnet accounts.** The testnet faucet funds each with 10 NEAR:
   ```bash
   node scripts/testnet-account.ts <payer>.testnet --env     # writes PAYER_ACCOUNT / PAYER_PRIVATE_KEY to .env.local
   node scripts/testnet-account.ts <supplier>.testnet --file # the supplier's key stays in ~/.config
   ```
3. **Get testnet USDC** for the payer from [faucet.circle.com](https://faucet.circle.com/)
   (NEAR Testnet, 20 USDC every 2 hours).
4. **Run the end-to-end suite:**
   ```bash
   RECEIVER_ACCOUNT=<supplier>.testnet npm run test:e2e
   ```
   It pays one approved PO and checks the payment from three sides: on chain (receiver, amount,
   memo, final status), in the receiver's balance, and on the PO (`paid` with the same tx hash). It
   then checks that paying again is refused. Four more orders must be refused with nothing sent
   (above the cap, payout account missing, mainnet account, token not allowed), and an unapproved
   order must be refused by the supply server.

### Live payment on mainnet (real money)

The confidential suite pays one 0.50 USD PO from the local demo for real, then checks it from every
side: both confidential balances moved by exactly 0.50, 1Click reports `SUCCESS` with no public NEAR
transaction, and the PO is `paid` with the intent hash. A second order above the cap must be refused
with nothing moved.

```bash
# MAINNET_PAYER_ACCOUNT, MAINNET_PAYER_PRIVATE_KEY, ONECLICK_API_KEY in .env.local
npm run shield -- 0.50
E2E_MAINNET=1 npm run test:e2e:mainnet
```

The receiver is read from `~/.config/near-payment-mcp/mainnet-keys/conf-recipient-1.json`
(`{account_id, private_key}`). Its key is used only to read its own confidential balance.

### Use it from Claude Code

```bash
claude mcp add --transport http supply http://127.0.0.1:8790/mcp
claude mcp add payment -e SUPPLY_URL=http://127.0.0.1:8790 -- \
  node --disable-warning=ExperimentalWarning --env-file=$PWD/.env.local $PWD/src/main.ts
# or the confidential rail on mainnet:
claude mcp add payment-private -e SUPPLY_URL=http://127.0.0.1:8790 -e NEAR_NETWORK=mainnet -- \
  node --disable-warning=ExperimentalWarning --env-file=$PWD/.env.local $PWD/src/main.ts
SUPPLY_URL=http://127.0.0.1:8790 SUPPLY_API_KEY=<northbeck buyer key> npm run login   # once, in a browser
```

In Claude Code, sign in to `supply` (`/mcp`) with the **owner** key, then try:

> In Northbeck Metalworks, raise a test purchase order with one of our existing suppliers for the
> 1.5 mm stainless sheet: 2 kg at 2.95 USD per kg, no freight. Approve it up to 10 USD. Set that
> supplier's payout account to network near, account `<supplier>.testnet`, token usdc. Then
> run payment_preview, show me what will be paid, and wait for my go before payment_pay.

`npm run whoami` shows the payment MCP's sign-in. `npm run logout` revokes the session at the server.

## Configuration (`.env.local`)

| variable | default | |
|---|---|---|
| `SUPPLY_URL` | `http://127.0.0.1:8790` | the supply server |
| `SUPPLY_API_KEY` | | only used by `npm run login`, which copies it to the clipboard for the sign-in page |
| `NEAR_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `RAIL` | `public` on testnet, `confidential` on mainnet | confidential is mainnet only |
| `NEAR_RPC_URL` | FastNEAR testnet / mainnet | |
| `PAYER_ACCOUNT`, `PAYER_PRIVATE_KEY` | | the testnet hot wallet |
| `MAINNET_PAYER_ACCOUNT`, `MAINNET_PAYER_PRIVATE_KEY` | | the mainnet hot wallet (separate, so neither network signs with the other's key) |
| `ONECLICK_API_KEY` | | 1Click partner key, required by the confidential rail |
| `PER_PAYMENT_CAP`, `DAILY_CAP` | `50`, `100` | in the PO currency |
| `LEDGER_FILE`, `SUPPLY_TOKEN_FILE`, `WALLET_FILE` | under `~/.config/near-payment-mcp/` | the wallet file is used only when no payer is configured; `wallet_create` writes it |

## Limits, honestly

- **The caps are enforced by this program, not by a contract.** The hard limit is what the payer hot
  wallet holds, so keep only working capital in it. A NEAR function-call access key cannot attach
  the 1 yoctoNEAR that `ft_transfer` requires, so the key cannot be restricted that way.
- **The public rail is public.** Payer, receiver, amount and memo (`PO <code>`) are visible to anyone
  in an explorer. That is fine for a testnet demo, and it is why real orders need the confidential
  rail.
- **Confidential means hidden from the public, not from everyone.** The operators of the
  confidential shard and 1Click see the transfers. The payment MCP trusts 1Click to deliver a quote it
  has signed for. It checks every field it signs, but it cannot audit the private shard afterwards.
- **The supplier receives into a confidential balance,** not their NEAR wallet. They use it with
  their own key, through a wallet that supports Confidential Intents (near.com is one integrator).
- **Access to Confidential Intents is at NEAR Intents' discretion.** Their API terms allow them to
  whitelist or KYB developers for confidential swaps. The key this project uses works today.
- **Stuck payments.** If a signed transaction never becomes visible and its expiry cannot be proven,
  for example because the RPC no longer has its reference block, the attempt stays `pending` rather
  than guessing. A person checks the tx hash in an explorer and records the outcome. It is never
  re-paid automatically.
- **The created wallet's key is a local file** (`0600`, never sent to Claude), like the sign-in
  tokens. Anyone with access to this user account can read it, and losing it loses the funds: back
  it up, and keep only working capital in it.
- **Each user needs their own NEAR Intents API key.** The extension cannot ship one: it would be a
  shared secret in every copy.
- **A funding refund arrives as the token that was sent** (for example Base USDC), in the payer's
  confidential balance; it is not lost, but it is not NEAR USDC until swapped.
- **One payer, one process.** Two payment MCPs sharing one payer key could collide on nonces.
- **Payout accounts** are only as trustworthy as the approver who set them. The supply server's
  guide says to confirm them on a known channel.

## Next

- **Gasless invoices:** the supplier signs the invoice or order acceptance off-chain with their NEAR
  key (NEP-413), and the payment MCP checks the signature before paying. That costs the supplier no
  gas and proves they control the payout account.
- Later: escrow and staged payments, and Zcash payouts.

## Layout

```text
src/pay.ts             payment flow and state machine
src/policy.ts          pre-flight checks (pure)
src/amount.ts          exact decimal ↔ token units
src/ledger.ts          SQLite ledger of attempts and events
src/rails/             rail interface; public-near.ts (NEP-141 ft_transfer); confidential.ts
                       (Confidential Intents); intents.ts (1Click, NEP-413, checks); near-rpc.ts
src/shield.ts          funding the confidential balance from a NEAR wallet (CLI)
src/fund.ts            funding from other chains via a 1Click deposit address (wallet_fund)
src/wallet.ts          the created payer wallet (implicit account, local key file)
src/signin.ts          supplier-server sign-in started from the chat
src/runtime.ts         lazy rail/payments, so the server starts before set-up; payment_setup_check
src/supply/            sign-in to the supply server and operation calls
src/server.ts          MCP tools; src/main.ts entry (serve, login, whoami, logout)
manifest.json          Claude desktop extension; scripts/pack-mcpb.sh builds it
scripts/               testnet account creation; seed-demo-brewery.ts (fictional brewery for a live demo)
test/                  unit tests; test/e2e/ live suites (opt-in): local-sim (simulated chain),
                       local-demo (testnet), confidential-mainnet (mainnet)
```
