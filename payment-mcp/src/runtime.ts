// What the running MCP server needs, built on first use, so the server starts (and payment_setup_check
// works) before the wallet, the 1Click key or the sign-in exist. A first-time user in the Claude app
// sets those up from the chat.

import { fromUnits } from './amount.ts';
import type { Config } from './config.ts';
import { Funding } from './fund.ts';
import { Ledger } from './ledger.ts';
import { Payments } from './pay.ts';
import { ConfidentialRail } from './rails/confidential.ts';
import { OneClick } from './rails/intents.ts';
import { NearRpc } from './rails/near-rpc.ts';
import { PublicNearRail } from './rails/public-near.ts';
import type { Rail } from './rails/rail.ts';
import { SignInFlow } from './signin.ts';
import { NotSignedIn, type SupplyAuth } from './supply/auth.ts';
import type { SupplyApi } from './supply/client.ts';
import { createWallet, loadWallet, type Wallet } from './wallet.ts';

export class SetupNeeded extends Error {
  readonly next: string;
  constructor(message: string, next: string) {
    super(`${message} Next: ${next}`);
    this.next = next;
  }
}

export class Runtime {
  readonly cfg: Config;
  readonly supply: SupplyApi;
  readonly signIn: SignInFlow;
  readonly ledger: Ledger;
  private wallet: { w: Wallet; source: 'settings' | 'wallet file' } | null = null;
  private built: { rail: Rail; payments: Payments } | null = null;
  private readonly makeRail: ((payer: Wallet) => Rail) | undefined;
  constructor(o: { cfg: Config; supply: SupplyApi; auth: SupplyAuth; signIn?: SignInFlow; ledger?: Ledger; makeRail?: (payer: Wallet) => Rail }) {
    this.cfg = o.cfg;
    this.makeRail = o.makeRail;
    this.supply = o.supply;
    this.signIn = o.signIn ?? new SignInFlow({ auth: o.auth, supplyApiKey: o.cfg.supplyApiKey });
    this.ledger = o.ledger ?? new Ledger(o.cfg.ledgerFile);
  }

  async init(): Promise<this> {
    if (this.cfg.payer) this.wallet = { w: this.cfg.payer, source: 'settings' };
    else {
      const w = await loadWallet(this.cfg.walletFile);
      if (w) this.wallet = { w, source: 'wallet file' };
    }
    return this;
  }

  get payer() {
    return this.wallet ? { account_id: this.wallet.w.accountId, source: this.wallet.source } : null;
  }

  oneClick(): OneClick {
    if (!this.cfg.oneClickApiKey) {
      throw new SetupNeeded('No NEAR Intents (1Click) API key is configured.', 'get one at partners.near-intents.org (key type "1Click API") and paste it into the extension settings.');
    }
    return new OneClick({ apiKey: this.cfg.oneClickApiKey });
  }

  private payerOrThrow(): Wallet {
    if (this.wallet) return this.wallet.w;
    if (this.cfg.rail === 'confidential') throw new SetupNeeded('There is no payer wallet yet.', 'call wallet_create, or paste an existing account and key into the extension settings.');
    const p = this.cfg.network === 'mainnet' ? 'MAINNET_' : '';
    throw new SetupNeeded('There is no payer wallet.', `set ${p}PAYER_ACCOUNT and ${p}PAYER_PRIVATE_KEY.`);
  }

  get(): { rail: Rail; payments: Payments } {
    if (this.built) return this.built;
    const payer = this.payerOrThrow();
    const rail: Rail = this.makeRail ? this.makeRail(payer) : this.cfg.rail === 'confidential'
      ? new ConfidentialRail({ payerAccountId: payer.accountId, payerKey: payer.key, api: this.oneClick(), rpc: new NearRpc(this.cfg.rpcUrl) })
      : new PublicNearRail({ network: this.cfg.network, rpcUrl: this.cfg.rpcUrl, payerAccountId: payer.accountId, payerKey: payer.key });
    this.built = { rail, payments: new Payments({ supply: this.supply, ledger: this.ledger, rail, policy: this.cfg.policy }) };
    return this.built;
  }

  funding(): Funding {
    if (this.cfg.rail !== 'confidential') throw new Error('Funding from other chains is for the confidential (mainnet) rail.');
    return new Funding({ api: this.oneClick(), payerAccountId: this.payerOrThrow().accountId, nearUsdcContract: this.cfg.policy.tokens.usdc!.contract });
  }

  /** Creates the payer wallet file; only when no wallet exists at all. */
  async createWallet(): Promise<{ account_id: string; stored_in: string }> {
    if (this.cfg.rail !== 'confidential') throw new Error('wallet_create is for the confidential (mainnet) rail; testnet uses a configured account.');
    if (this.wallet) throw new Error(`A payer wallet already exists (${this.wallet.w.accountId}, from the ${this.wallet.source}); it is never replaced.`);
    const w = await createWallet(this.cfg.walletFile);
    this.wallet = { w, source: 'wallet file' };
    this.built = null;
    return { account_id: w.accountId, stored_in: this.cfg.walletFile };
  }

  /** Every prerequisite, each with what to do next. Read-only. */
  async setupCheck() {
    const steps: { step: string; ok: boolean; detail: string; next?: string }[] = [];
    const add = (step: string, ok: boolean, detail: string, next?: string) => steps.push(ok ? { step, ok, detail } : { step, ok, detail, next });
    const conf = this.cfg.rail === 'confidential';

    add('network', true, `${this.cfg.network}, ${conf ? 'confidential payments (NEAR Confidential Intents)' : 'public payments'}; supplier server ${this.cfg.supplyUrl.origin}`);
    if (conf) {
      add('NEAR Intents API key', !!this.cfg.oneClickApiKey, this.cfg.oneClickApiKey ? 'configured' : 'missing',
        'get one at partners.near-intents.org (key type "1Click API") and paste it into the extension settings');
    }

    add('payer wallet', !!this.wallet, this.wallet ? `${this.wallet.w.accountId} (from the ${this.wallet.source})` : 'none yet',
      conf ? 'call wallet_create (or paste an existing account and key into the extension settings)' : 'configure PAYER_ACCOUNT and PAYER_PRIVATE_KEY');

    const si = this.signIn.current;
    try {
      const me = await this.supply.call<{ company_name?: string; email?: string; scopes?: string[] }>('whoami', {}, { reason: 'payment MCP: setup check' });
      const scopes = me.scopes ?? [];
      const safe = scopes.includes('write') && !scopes.includes('approve');
      add('supplier server sign-in', safe, `${me.email ?? '?'} at ${me.company_name ?? '?'}, scopes [${scopes.join(' ')}]`,
        'the payment sign-in needs read+write and must not hold approve; sign in again with a payments key (payment_sign_in)');
    } catch (e) {
      const waiting = si.state === 'waiting';
      const detail = waiting ? `waiting for the browser sign-in started at ${si.started_at}`
        : si.state === 'failed' ? `last sign-in failed: ${si.error}`
        : e instanceof NotSignedIn ? 'not signed in' : `cannot reach the supplier server: ${(e as Error).message}`;
      add('supplier server sign-in', false, detail, waiting ? 'finish signing in in the browser tab, then run payment_setup_check again'
        : 'call payment_sign_in and paste your payments key into the page it opens (never into the chat)');
    }

    const usdc = this.cfg.policy.tokens.usdc!;
    if (this.wallet && (!conf || this.cfg.oneClickApiKey)) {
      try {
        const bal = await this.get().rail.balance(usdc);
        add(conf ? 'private balance' : 'wallet balance', bal > 0n, `${fromUnits(bal, usdc.decimals)} USDC`,
          conf ? 'call wallet_fund with an amount and the chain you will send USDC from (e.g. base)' : 'send testnet USDC to the payer account');
      } catch (e) {
        add('balance', false, `could not read it: ${(e as Error).message}`, 'try again in a minute');
      }
    }

    add('limits', true, `up to ${this.cfg.policy.perPaymentCap} per payment and ${this.cfg.policy.dailyCap} per day (USD); change them in the extension settings`);
    const open = this.ledger.open().length;
    if (open) add('unfinished payments', false, `${open} payment(s) were interrupted`, 'call payment_reconcile');

    const missing = steps.filter((s) => !s.ok);
    return { ready: missing.length === 0, next: missing[0]?.next ?? 'ready: ask for a PO to be paid (payment_preview, then payment_pay)', steps };
  }
}
