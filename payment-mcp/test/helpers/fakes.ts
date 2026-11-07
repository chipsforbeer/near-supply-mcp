// Fakes that follow the real contracts: the supplier server's PO payment state machine and
// request_key journal (teammate repo: src/ops/procurement/po-payment.ts, src/ops/run.ts), and a chain.
import { SupplyError, type CallOptions, type SupplyApi } from '../../src/supply/client.ts';
import type { PayRequest, Prepared, Rail, TxStatus } from '../../src/rails/rail.ts';
import type { TokenConfig } from '../../src/policy.ts';

export const PO_ID = '11111111-1111-4111-8111-111111111111';
export const SUPPLIER_ID = '33333333-3333-4333-8333-333333333333';

type Po = {
  po_id: string; po_code: string; status: string; currency: string; total: string;
  approved_max_amount: string | null; approved_at: string | null; approved_by: string | null;
  payment_status: 'unpaid' | 'instructed' | 'paid' | 'failed'; payment_ref: string | null; payment_note?: string;
  supplier_id: string; supplier: string;
};

export class FakeSupply implements SupplyApi {
  po: Po = {
    po_id: PO_ID, po_code: 'PO-0001', status: 'approved', currency: 'USD', total: '4237.200000',
    approved_max_amount: '4300.000000', approved_at: '2026-11-03T00:00:00Z', approved_by: 'owner@example.com',
    payment_status: 'unpaid', payment_ref: null, supplier_id: SUPPLIER_ID, supplier: 'Example Mill Direct',
  };
  payout: { network: string; account_id: string; token: string } | null = { network: 'near', account_id: 'mill-direct.testnet', token: 'usdc' };
  journal = new Map<string, { argsHash: string; status: 'completed' | 'failed'; result?: unknown }>();
  calls: { op: string; args: Record<string, unknown>; key?: string }[] = [];
  /** throw a network error AFTER the server processed this op (lost response), n times */
  loseResponse: Record<string, number> = {};

  async call<T>(op: string, args: Record<string, unknown>, opts: CallOptions): Promise<T> {
    this.calls.push({ op, args, key: opts.requestKey });
    const run = () => this.handle(op, args);
    let result: unknown;
    if (opts.requestKey) {
      const argsHash = JSON.stringify({ op, args });
      const j = this.journal.get(opts.requestKey);
      if (j && j.argsHash !== argsHash) throw new SupplyError(op, 409, 'request_key_reused', 'different call');
      if (j?.status === 'completed') result = j.result;
      else {
        try {
          result = run();
          this.journal.set(opts.requestKey, { argsHash, status: 'completed', result });
        } catch (e) {
          this.journal.set(opts.requestKey, { argsHash, status: 'failed' });
          throw e;
        }
      }
    } else result = run();
    if (this.loseResponse[op]) {
      this.loseResponse[op]--;
      throw new TypeError('fetch failed (response lost)');
    }
    return structuredClone(result) as T;
  }

  private handle(op: string, args: Record<string, unknown>): unknown {
    const po = this.po;
    const conflict = (m: string) => new SupplyError(op, 409, 'conflict', m);
    if (args.po_id !== undefined && args.po_id !== po.po_id) throw new SupplyError(op, 404, 'not_found', 'Purchase order not found.');
    switch (op) {
      case 'po_get':
        return { ...po };
      case 'supplier_get':
        return { payout_accounts: this.payout ? [{ ...this.payout, account_id: `...${this.payout.account_id.slice(-6)}` }] : [] };
      case 'po_payment_instruction': {
        if (!po.approved_at || po.status === 'draft' || po.status === 'cancelled') throw conflict(`${po.po_code} is not approved for payment.`);
        if (po.payment_status === 'paid') throw conflict(`${po.po_code} is already paid.`);
        if (po.payment_status === 'instructed') throw conflict(`${po.po_code} already has an open payment instruction; record its outcome first.`);
        if (Number(po.total) > Number(po.approved_max_amount)) throw conflict('above the approved maximum');
        if (!this.payout) throw conflict('The supplier has no payout account');
        po.payment_status = 'instructed';
        return {
          po_id: po.po_id, po_code: po.po_code, supplier_name: po.supplier, network: this.payout.network,
          account_id: this.payout.account_id, token: this.payout.token, amount: po.total, currency: po.currency,
          approval: { approved_by: po.approved_by, approved_at: po.approved_at, approved_max_amount: po.approved_max_amount },
        };
      }
      case 'po_payment_record': {
        if (po.payment_status !== 'instructed') throw conflict(`${po.po_code} has no open payment instruction (status ${po.payment_status}).`);
        const ref = String(args.payment_ref);
        if (ref.length < 4 || ref.length > 200) throw new SupplyError(op, 400, 'invalid_arguments', 'payment_ref');
        po.payment_status = args.outcome as 'paid' | 'failed';
        po.payment_ref = ref;
        po.payment_note = args.note as string | undefined;
        return { po_code: po.po_code, payment_status: po.payment_status, payment_ref: ref };
      }
    }
    throw new SupplyError(op, 404, 'unknown_operation', op);
  }
}

export class FakeRail implements Rail {
  readonly name = 'fake';
  readonly network = 'testnet' as const;
  balanceUnits = 100_000_000_000n;
  sent: PayRequest[] = []; // what actually landed on the chain
  broadcasts = 0;
  private txs = new Map<string, { req: PayRequest; landed: boolean }>();
  private n = 0;
  /** next broadcast lands but throws (lost response) */
  loseBroadcastResponse = false;
  /** next broadcast throws and never lands */
  dropNextBroadcast = false;
  /** prepared txs count as expired when never landed */
  expired = false;
  /** landed txs fail on chain */
  failOnChain = false;
  /** status reports pending this many times before final */
  pendingPolls = 0;
  /** ensureReceiver refuses with this reason */
  receiverProblem: string | null = null;
  ensured: string[] = [];

  async balance(_t: TokenConfig) { return this.balanceUnits; }
  async ensureReceiver(req: PayRequest) { this.ensured.push(req.receiver); return this.receiverProblem; }
  async prepare(req: PayRequest): Promise<Prepared> {
    const ref = `faketx-${++this.n}`;
    this.txs.set(ref, { req, landed: false });
    return { ref, payload: ref };
  }
  async broadcast(payload: string) {
    this.broadcasts++;
    const t = this.txs.get(payload)!;
    if (this.dropNextBroadcast) { this.dropNextBroadcast = false; throw new Error('connection reset'); }
    if (!t.landed) { // same signed tx lands at most once (nonce)
      t.landed = true;
      this.sent.push(t.req);
      this.balanceUnits -= t.req.units;
    }
    if (this.loseBroadcastResponse) { this.loseBroadcastResponse = false; throw new Error('timeout'); }
  }
  async status(ref: string): Promise<TxStatus> {
    const t = this.txs.get(ref);
    if (!t || !t.landed) return this.expired ? { state: 'dropped' } : { state: 'pending' };
    if (this.pendingPolls > 0) { this.pendingPolls--; return { state: 'pending' }; }
    return this.failOnChain ? { state: 'failed', error: 'FunctionCallError: insufficient balance' } : { state: 'success' };
  }
  link(ref: string) { return `https://testnet.nearblocks.io/txns/${ref}`; }
}
