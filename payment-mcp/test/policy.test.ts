import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountNetworks, checkPolicy, type PolicyConfig } from '../src/policy.ts';
import type { PaymentInstruction } from '../src/supply/instruction.ts';

const PO = '11111111-1111-4111-8111-111111111111';
const cfg: PolicyConfig = {
  network: 'testnet',
  tokens: { usdc: { contract: 'usdc.example.testnet', decimals: 6, currency: 'USD' } },
  perPaymentCap: '5000',
  dailyCap: '10000',
};
// Mirrors the teammate's demo: 2 bundles x 708 kg x 2.95 + 60 freight, approved up to 4300.
const instr = (over: Partial<PaymentInstruction> = {}): PaymentInstruction => ({
  po_id: PO, po_code: 'PO-0001', supplier_name: 'Example Mill Direct', network: 'near',
  account_id: 'mill-direct.testnet', token: 'usdc', amount: '4237.200000', currency: 'USD',
  approval: { approved_by: 'owner@example.com', approved_at: '2026-11-03T00:00:00Z', approved_max_amount: '4300.000000' },
  ...over,
});
const run = (i: PaymentInstruction, extra: { spentToday?: string; payerBalanceUnits?: bigint } = {}) =>
  checkPolicy(cfg, { poId: PO, instruction: i, spentToday: extra.spentToday ?? '0', payerBalanceUnits: extra.payerBalanceUnits });
const reasons = (r: ReturnType<typeof run>) => (r.ok ? [] : r.reasons).join(' | ');

test('the demo payment passes and converts to base units', () => {
  const r = run(instr(), { payerBalanceUnits: 10_000_000_000n });
  assert.ok(r.ok, reasons(r));
  assert.equal(r.units, 4_237_200_000n);
  assert.equal(r.token.contract, 'usdc.example.testnet');
});

test('refusals', () => {
  const cases: [string, PaymentInstruction, { spentToday?: string; payerBalanceUnits?: bigint }, RegExp][] = [
    ['wrong PO', instr({ po_id: '22222222-2222-4222-8222-222222222222' }), {}, /not the requested/],
    ['other network', instr({ network: 'zcash' }), {}, /only pays on NEAR/],
    ['mainnet account on testnet', instr({ account_id: 'mill-direct.near' }), {}, /not a testnet account/],
    ['unknown token', instr({ token: 'usdt' }), {}, /allowlist/],
    ['currency mismatch', instr({ currency: 'EUR' }), {}, /no FX/],
    ['above approval', instr({ amount: '4300.000001' }), {}, /approved maximum/],
    ['no approval cap', instr({ approval: { approved_by: null, approved_at: 'x', approved_max_amount: null } }), {}, /no approved maximum/],
    ['above per-payment cap', instr({ amount: '6000', approval: { approved_by: 'a', approved_at: 'x', approved_max_amount: '9000' } }), {}, /per-payment cap/],
    ['daily cap', instr(), { spentToday: '6000' }, /daily cap/],
    ['zero', instr({ amount: '0' }), {}, /greater than zero/],
    ['too precise', instr({ amount: '1.0000001' }), {}, /decimal places/],
    ['malformed', instr({ amount: '1e3' }), {}, /Not a non-negative decimal/],
    ['balance', instr(), { payerBalanceUnits: 1n }, /balance is too low/],
  ];
  for (const [name, i, extra, re] of cases) {
    const r = run(i, extra);
    assert.equal(r.ok, false, name);
    assert.match(reasons(r), re, name);
  }
});

test('token name match is case-insensitive', () => {
  assert.ok(run(instr({ token: 'USDC' })).ok);
});

test('account networks', () => {
  assert.deepEqual(accountNetworks('mill-direct.testnet'), ['testnet']);
  assert.deepEqual(accountNetworks('mill-direct.near'), ['mainnet']);
  assert.deepEqual(accountNetworks('a'.repeat(64)), ['testnet', 'mainnet']);
  assert.deepEqual(accountNetworks('0x' + 'b'.repeat(40)), ['testnet', 'mainnet']);
});
