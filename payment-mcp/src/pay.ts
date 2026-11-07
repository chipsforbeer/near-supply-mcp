// The payment flow. Claude gives a po_id; everything else (payee, token, amount, approval) comes
// from the supplier server directly, is checked by our own policy, and only then reaches a rail.
//
// Each step persists its result before the next side effect, so a crash at any point can be resumed
// by calling pay() or reconcile() again without paying twice.

import { add } from './amount.ts';
import { CLOSED, type Attempt, type Ledger } from './ledger.ts';
import { checkPolicy, type PolicyConfig } from './policy.ts';
import type { Rail, TxStatus } from './rails/rail.ts';
import { SupplyError, type SupplyApi } from './supply/client.ts';
import { PaymentInstruction } from './supply/instruction.ts';

export type PayOutcome =
  | 'paid' // settled on chain and recorded on the PO
  | 'failed' // settled as failed on chain, recorded as failed
  | 'refused' // our policy refused; recorded as failed on the PO
  | 'not_instructed' // the supplier server refused to instruct (not approved, no payout account, already paid…)
  | 'pending'; // broadcast but not final yet: call payment_status / payment_reconcile later

export type PayResult = {
  po_id: string;
  attempt: number;
  outcome: PayOutcome;
  tx_ref?: string | null;
  link?: string | null;
  amount?: string | null;
  currency?: string | null;
  reasons?: string[];
};

type PoView = {
  po_id: string;
  po_code: string;
  status: string;
  currency: string;
  total: string;
  approved_max_amount: string | null;
  approved_at: string | null;
  approved_by: string | null;
  payment_status: 'unpaid' | 'instructed' | 'paid' | 'failed';
  payment_ref: string | null;
  supplier_id: string;
  supplier: string;
};

export type PaymentsDeps = {
  supply: SupplyApi;
  ledger: Ledger;
  rail: Rail;
  policy: PolicyConfig;
  /** how long pay() waits for finality before returning 'pending' */
  settleTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const isServerRefusal = (e: unknown) =>
  e instanceof SupplyError && ['conflict', 'not_found', 'forbidden', 'invalid_arguments'].includes(e.code);

export class Payments {
  private readonly d: Required<PaymentsDeps>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: PaymentsDeps) {
    this.d = {
      settleTimeoutMs: 60_000,
      pollMs: 2_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...deps,
    };
  }

  /** Read-only: what pay() would do, without opening an instruction or touching the chain. */
  async preview(poId: string) {
    const po = await this.d.supply.call<PoView>('po_get', { po_id: poId }, { reason: 'payment MCP: preview payment' });
    const sup = await this.d.supply.call<{ payout_accounts: { network: string; account_id: string; token: string }[] }>(
      'supplier_get', { supplier_id: po.supplier_id }, { reason: 'payment MCP: preview payout account' },
    );
    const payout = sup.payout_accounts.find((p) => p.network === 'near');
    const reasons: string[] = [];
    if (!po.approved_at) reasons.push(`${po.po_code} is not approved.`);
    if (po.payment_status === 'paid') reasons.push(`${po.po_code} is already paid (${po.payment_ref}).`);
    if (po.payment_status === 'instructed' && !this.openAttempt(poId)) {
      reasons.push(`${po.po_code} has an open payment instruction that this payment MCP did not create; record its outcome first.`);
    }
    if (!payout) reasons.push(`${po.supplier} has no NEAR payout account.`);
    let tokenBalance: string | undefined;
    if (payout) {
      // supplier_get masks the account to its last 6 characters; enough to tell testnet from mainnet
      const masked = payout.account_id;
      const net = masked.endsWith('estnet') ? 'testnet' : masked.endsWith('.near') ? 'mainnet' : null;
      if (net && net !== this.d.policy.network) reasons.push(`Payout account ${masked} is a ${net} account; this payment MCP pays on ${this.d.policy.network}.`);
      const fake = PaymentInstruction.parse({
        po_id: po.po_id, po_code: po.po_code, supplier_name: po.supplier, network: payout.network,
        // stand-in with the right suffix: the network was checked above from the masked account
        account_id: this.d.policy.network === 'testnet' ? 'preview.testnet' : 'preview.near', token: payout.token, amount: po.total,
        currency: po.currency, approval: { approved_by: po.approved_by, approved_at: po.approved_at ?? '', approved_max_amount: po.approved_max_amount },
      });
      const token = this.d.policy.tokens[payout.token.toLowerCase()];
      const balance = token ? await this.d.rail.balance(token) : undefined;
      const r = checkPolicy(this.d.policy, {
        poId, instruction: fake, spentToday: add(...this.d.ledger.committedToday(po.currency)), payerBalanceUnits: balance,
      });
      if (!r.ok) reasons.push(...r.reasons);
      if (balance !== undefined && token) tokenBalance = `${balance} base units of ${token.contract}`;
    }
    return {
      po_id: po.po_id, po_code: po.po_code, supplier: po.supplier, amount: po.total, currency: po.currency,
      payout: payout ? { account: payout.account_id, token: payout.token } : null,
      rail: this.d.rail.name, network: this.d.rail.network, payer_token_balance: tokenBalance,
      would_pay: reasons.length === 0, reasons,
      note: 'Preview only. pay re-checks everything against the live instruction, including the full payout account.',
    };
  }

  // A single payer must advance only one attempt at a time, including across different POs.
  // The whole flow is queued so state reads, daily-cap checks, signing and reconciliation
  // cannot race. Rejected calls release the queue so an explicit retry can resume safely.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Pay one approved PO, or resume an attempt that was interrupted. */
  pay(poId: string): Promise<PayResult> {
    return this.serial(() => {
      const open = this.openAttempt(poId);
      return this.advance(open ?? this.d.ledger.begin(poId));
    });
  }

  /** Drive every open attempt as far as it can go (startup, or after a crash). */
  reconcile(): Promise<PayResult[]> {
    return this.serial(async () => {
      const out: PayResult[] = [];
      for (const a of this.d.ledger.open()) {
        // instructing/instructed with no side effect yet: resuming would pay; leave that to an explicit pay()
        if (a.state === 'instructing' || a.state === 'instructed') continue;
        out.push(await this.advance(a, { waitForFinal: false }));
      }
      return out;
    });
  }

  async status(poId: string) {
    const attempts = this.d.ledger.history(poId);
    const last = attempts.at(-1);
    let chain: TxStatus | null = null;
    const sameRail = !last?.rail || last.rail === this.d.rail.name;
    if (last?.tx_ref && sameRail) chain = await this.d.rail.status(last.tx_ref, last.tx_payload);
    // tx_payload is a signed transaction: never hand it out
    return {
      attempts: attempts.map(({ tx_payload: _p, ...rest }) => rest), chain,
      link: last?.tx_ref && sameRail ? this.d.rail.link(last.tx_ref) : null,
      ...(sameRail ? {} : { note: `The last attempt was made on rail ${last!.rail}; run this server with that rail to see its status.` }),
    };
  }

  private openAttempt(poId: string): Attempt | undefined {
    const last = this.d.ledger.latest(poId);
    return last && !CLOSED.includes(last.state) ? last : undefined;
  }

  private async advance(a: Attempt, opts: { waitForFinal?: boolean } = {}): Promise<PayResult> {
    const L = this.d.ledger;
    const key = (kind: 'pay' | 'rec') => `${kind}:${a.po_id}:${a.attempt}`;

    for (;;) {
      // A signed payment can only be checked and re-sent by the rail that signed it.
      if (a.rail && a.rail !== this.d.rail.name && ['signed', 'broadcast'].includes(a.state)) {
        throw new Error(`Attempt ${a.attempt} for PO ${a.po_id} was signed on rail ${a.rail}; this server runs ${this.d.rail.name}. Start it with that rail to finish the payment.`);
      }
      switch (a.state) {
        case 'instructing': {
          let raw: unknown;
          try {
            // Same request_key on a retry replays the server's cached instruction instead of "already instructed".
            raw = await this.d.supply.call('po_payment_instruction', { po_id: a.po_id }, { reason: 'payment MCP: fetch approved payment instruction', requestKey: key('pay') });
          } catch (e) {
            if (!isServerRefusal(e)) throw e; // network trouble: attempt stays 'instructing', safe to retry
            a = L.update(a, 'aborted', { error: (e as Error).message });
            return this.result(a, 'not_instructed', [(e as Error).message]);
          }
          const parsed = PaymentInstruction.safeParse(raw);
          if (!parsed.success) {
            a = L.update(a, 'refused', { instruction: JSON.stringify(raw), error: `Unexpected instruction shape: ${parsed.error.message}` });
            continue;
          }
          a = L.update(a, 'instructed', { instruction: JSON.stringify(parsed.data), amount: parsed.data.amount, currency: parsed.data.currency });
          continue;
        }

        case 'instructed': {
          const instr = PaymentInstruction.parse(JSON.parse(a.instruction!));
          // A replayed instruction can be stale (e.g. the local ledger was restored from an old copy):
          // the live payment_status is the final word before any money moves.
          const live = await this.d.supply.call<PoView>('po_get', { po_id: a.po_id }, { reason: 'payment MCP: confirm PO is still instructed' });
          if (live.payment_status !== 'instructed') {
            a = L.update(a, 'aborted', { error: `PO payment_status is ${live.payment_status}, not instructed; not paying.` });
            return this.result(a, 'not_instructed', [a.error!]);
          }
          const token = this.d.policy.tokens[instr.token.toLowerCase()];
          const balance = token ? await this.d.rail.balance(token) : undefined;
          const check = checkPolicy(this.d.policy, {
            poId: a.po_id, instruction: instr, spentToday: add(...L.committedToday(instr.currency)), payerBalanceUnits: balance,
          });
          if (!check.ok) {
            a = L.update(a, 'refused', { error: check.reasons.join(' ') });
            continue;
          }
          const req = { poId: a.po_id, poCode: instr.po_code, receiver: instr.account_id, token: check.token, units: check.units };
          const notReady = await this.d.rail.ensureReceiver(req);
          if (notReady) {
            a = L.update(a, 'refused', { error: notReady });
            continue;
          }
          const prepared = await this.d.rail.prepare(req);
          // persisted BEFORE broadcast: from here on this exact tx is the only one this attempt may send
          a = L.update(a, 'signed', { rail: this.d.rail.name, tx_ref: prepared.ref, tx_payload: prepared.payload });
          continue;
        }

        case 'signed': {
          try {
            await this.d.rail.broadcast(a.tx_payload!);
          } catch (e) {
            // The tx may still have landed; stay 'signed' and let status() decide. Never re-sign.
            L.update(a, 'signed', {}, `broadcast error: ${(e as Error).message}`);
            const st = await this.d.rail.status(a.tx_ref!, a.tx_payload);
            if (st.state === 'pending') return this.result(a, 'pending', [`Broadcast error, will reconcile by tx hash: ${(e as Error).message}`]);
            a = L.update(a, 'broadcast');
            continue;
          }
          a = L.update(a, 'broadcast');
          continue;
        }

        case 'broadcast': {
          const st = await this.waitFinal(a.tx_ref!, a.tx_payload, opts.waitForFinal ?? true);
          if (st.state === 'pending') {
            // an RPC can accept a tx and lose it; re-sending the identical signed tx is harmless
            await this.d.rail.broadcast(a.tx_payload!).catch(() => undefined);
            return this.result(a, 'pending');
          }
          if (st.state === 'success') a = L.update(a, 'settled_ok');
          else a = L.update(a, 'settled_failed', { error: st.state === 'failed' ? st.error : 'Transaction was never included and has expired.' });
          continue;
        }

        case 'settled_ok':
        case 'settled_failed':
        case 'refused': {
          const paid = a.state === 'settled_ok';
          const link = a.tx_ref ? this.d.rail.link(a.tx_ref) : null;
          const note = paid
            ? `Paid by near-payment-mcp (${this.d.rail.name})${link ? `: ${link}` : ''}`
            : `Not paid by near-payment-mcp: ${a.error ?? 'unknown error'}`.slice(0, 1000);
          try {
            await this.d.supply.call('po_payment_record', {
              po_id: a.po_id, network: 'near',
              payment_ref: paid ? a.tx_ref! : a.tx_ref ?? `refused:${a.po_id.slice(0, 8)}:${a.attempt}`,
              outcome: paid ? 'paid' : 'failed', note,
            }, { reason: paid ? 'payment MCP: payment settled on NEAR' : 'payment MCP: payment not made', requestKey: key('rec') });
          } catch (e) {
            if (!isServerRefusal(e)) throw e; // stays settled_*: reconcile will record it
            a = L.update(a, 'recorded', { outcome: paid ? 'paid' : 'failed', error: `${a.error ?? ''} Record refused: ${(e as Error).message}`.trim() });
            return this.result(a, paid ? 'paid' : a.tx_ref ? 'failed' : 'refused', [`Supplier server refused the record: ${(e as Error).message}`]);
          }
          const wasRefused = a.state === 'refused';
          a = L.update(a, 'recorded', { outcome: paid ? 'paid' : 'failed' });
          return this.result(a, paid ? 'paid' : wasRefused ? 'refused' : 'failed', a.error ? [a.error] : undefined);
        }

        case 'recorded':
          return this.result(a, a.outcome === 'paid' ? 'paid' : 'failed');
        case 'aborted':
          return this.result(a, 'not_instructed', a.error ? [a.error] : undefined);
      }
    }
  }

  private async waitFinal(ref: string, payload: string | null, wait: boolean): Promise<TxStatus> {
    const deadline = Date.now() + (wait ? this.d.settleTimeoutMs : 0);
    for (;;) {
      const st = await this.d.rail.status(ref, payload);
      if (st.state !== 'pending' || Date.now() >= deadline) return st;
      await this.d.sleep(this.d.pollMs);
    }
  }

  private result(a: Attempt, outcome: PayOutcome, reasons?: string[]): PayResult {
    return {
      po_id: a.po_id, attempt: a.attempt, outcome, tx_ref: a.tx_ref, link: a.tx_ref ? this.d.rail.link(a.tx_ref) : null,
      amount: a.amount, currency: a.currency, ...(reasons?.length ? { reasons } : {}),
    };
  }
}

