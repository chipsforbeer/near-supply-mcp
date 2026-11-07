// Pre-flight checks run on every instruction before any rail is touched. Pure: no I/O.
// These are the payment MCP's own limits, independent of the supplier server's approval check. On the
// confidential rail nobody outside can audit a payment afterwards, so these checks matter even more.

import { add, AmountError, cmp, toUnits } from './amount.ts';
import type { PaymentInstruction } from './supply/instruction.ts';

export type NearNetwork = 'testnet' | 'mainnet';

export type TokenConfig = {
  /** NEP-141 contract id on this network */
  contract: string;
  decimals: number;
  /** ISO currency the token is pegged to; the PO currency must match exactly (no FX). */
  currency: string;
};

export type PolicyConfig = {
  network: NearNetwork;
  /** keyed by the token name the supplier server stores, e.g. "usdc" */
  tokens: Record<string, TokenConfig>;
  perPaymentCap: string;
  dailyCap: string;
};

export type PolicyInput = {
  poId: string;
  instruction: PaymentInstruction;
  /** sum already paid today (UTC), in the PO currency */
  spentToday: string;
  /** payer's balance of the token, in base units; omit to skip (preview without chain access) */
  payerBalanceUnits?: bigint;
};

export type PolicyResult =
  | { ok: true; token: TokenConfig; units: bigint }
  | { ok: false; reasons: string[] };

const IMPLICIT = /^([0-9a-f]{64}|0x[0-9a-f]{40})$/;

/** Which network a NEAR account id can live on. Implicit accounts exist on both. */
export function accountNetworks(accountId: string): NearNetwork[] {
  if (IMPLICIT.test(accountId)) return ['testnet', 'mainnet'];
  if (accountId.endsWith('.testnet') || accountId === 'testnet') return ['testnet'];
  return ['mainnet'];
}

export function checkPolicy(cfg: PolicyConfig, input: PolicyInput): PolicyResult {
  const i = input.instruction;
  const reasons: string[] = [];

  if (i.po_id !== input.poId) reasons.push(`Instruction is for PO ${i.po_id}, not the requested ${input.poId}.`);
  if (i.network !== 'near') reasons.push(`Payout network is ${i.network}; this payment MCP only pays on NEAR.`);
  if (!accountNetworks(i.account_id).includes(cfg.network)) {
    reasons.push(`Payout account ${i.account_id} is not a ${cfg.network} account.`);
  }

  const token = cfg.tokens[i.token.toLowerCase()];
  if (!token) {
    reasons.push(`Token "${i.token}" is not on this payment MCP's ${cfg.network} allowlist (${Object.keys(cfg.tokens).join(', ') || 'empty'}).`);
  } else if (token.currency !== i.currency) {
    reasons.push(`PO is in ${i.currency} but ${i.token} is pegged to ${token.currency}; no FX conversion is assumed.`);
  }

  let units: bigint | null = null;
  try {
    if (cmp(i.amount, '0') <= 0) reasons.push('Amount must be greater than zero.');
    if (i.approval.approved_max_amount === null) reasons.push('PO has no approved maximum.');
    else if (cmp(i.amount, i.approval.approved_max_amount) > 0) {
      reasons.push(`Amount ${i.amount} is above the approved maximum ${i.approval.approved_max_amount}.`);
    }
    if (cmp(i.amount, cfg.perPaymentCap) > 0) reasons.push(`Amount ${i.amount} is above the per-payment cap ${cfg.perPaymentCap}.`);
    if (cmp(add(input.spentToday, i.amount), cfg.dailyCap) > 0) {
      reasons.push(`Paying ${i.amount} would take today's total from ${input.spentToday} past the daily cap ${cfg.dailyCap}.`);
    }
    if (token) units = toUnits(i.amount, token.decimals);
  } catch (e) {
    if (e instanceof AmountError) reasons.push(e.message);
    else throw e;
  }

  if (units !== null && input.payerBalanceUnits !== undefined && input.payerBalanceUnits < units) {
    reasons.push(`Payer balance is too low for ${i.amount} ${i.token}.`);
  }

  if (reasons.length || !token || units === null) return { ok: false, reasons };
  return { ok: true, token, units };
}
