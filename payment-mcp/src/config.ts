import os from 'node:os';
import path from 'node:path';
import type { KeyPairString } from 'near-api-js';
import type { NearNetwork, PolicyConfig, TokenConfig } from './policy.ts';

// Circle's native USDC on NEAR (not bridged USDC.e). Testnet id checked on chain 2026-11-03:
// ft_metadata = USDC, 6 decimals. Mainnet id from Circle's SDK chain list.
const USDC: Record<NearNetwork, TokenConfig> = {
  testnet: { contract: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af', decimals: 6, currency: 'USD' },
  mainnet: { contract: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6, currency: 'USD' },
};
const RPC: Record<NearNetwork, string> = {
  // rpc.testnet.near.org measured ~3.3 s per call on 2026-11-03; FastNEAR ~0.3-0.9 s
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://free.rpc.fastnear.com',
};

export type RailKind = 'public' | 'confidential';

export type Config = {
  supplyUrl: URL;
  supplyMcpUrl: URL;
  /** only used by `login` (copied to the clipboard for the sign-in page) */
  supplyApiKey: string | undefined;
  tokenFile: string;
  ledgerFile: string;
  network: NearNetwork;
  rpcUrl: string;
  /** public: NEP-141 ft_transfer (visible). confidential: Confidential Intents via 1Click (mainnet only). */
  rail: RailKind;
  /** from the environment; when null, the wallet file below is used (see wallet.ts) */
  payer: { accountId: string; key: KeyPairString } | null;
  walletFile: string;
  /** 1Click partner key (partners.near-intents.org, type "1Click API"); required by the confidential rail */
  oneClickApiKey: string | undefined;
  policy: PolicyConfig;
};

const configDir = path.join(os.homedir(), '.config', 'near-payment-mcp');

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): Config {
  // An empty value means "not set": the desktop extension passes every install-dialog field, filled or not.
  const env = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v.trim() !== '')) as NodeJS.ProcessEnv;
  const supplyUrl = new URL(env.SUPPLY_URL ?? 'http://127.0.0.1:8790');
  const network = (env.NEAR_NETWORK ?? 'testnet') as NearNetwork;
  if (network !== 'testnet' && network !== 'mainnet') throw new Error(`NEAR_NETWORK must be testnet or mainnet, not ${network}`);
  const rail = (env.RAIL ?? (network === 'mainnet' ? 'confidential' : 'public')) as RailKind;
  if (rail !== 'public' && rail !== 'confidential') throw new Error(`RAIL must be public or confidential, not ${rail}`);
  if (rail === 'confidential' && network !== 'mainnet') throw new Error('Confidential Intents run on mainnet only: set NEAR_NETWORK=mainnet or RAIL=public.');
  // separate variables per network, so a testnet setup never signs with the mainnet key or vice versa
  const prefix = network === 'mainnet' ? 'MAINNET_' : '';
  const account = env[`${prefix}PAYER_ACCOUNT`];
  const key = env[`${prefix}PAYER_PRIVATE_KEY`]?.trim();
  if (key && !/^(ed25519|secp256k1):/.test(key)) throw new Error(`${prefix}PAYER_PRIVATE_KEY must look like ed25519:...`);
  return {
    supplyUrl,
    supplyMcpUrl: new URL('/mcp', supplyUrl),
    // NEAR_API_KEY: the name first used in .env.local for the supplier-server key
    supplyApiKey: env.SUPPLY_API_KEY ?? env.NEAR_API_KEY,
    tokenFile: env.SUPPLY_TOKEN_FILE ?? path.join(configDir, `${supplyUrl.host}.json`),
    // one ledger per supplier server and network, so local demo runs never mix with the hosted server
    ledgerFile: env.LEDGER_FILE ?? path.join(configDir, `payments-${supplyUrl.host.replace(/[^a-z0-9.-]/gi, '_')}-${network}.db`),
    network,
    rpcUrl: env.NEAR_RPC_URL ?? RPC[network],
    rail,
    payer: account && key ? { accountId: account, key: key as KeyPairString } : null,
    walletFile: env.WALLET_FILE ?? path.join(configDir, `wallet-${network}.json`),
    oneClickApiKey: env.ONECLICK_API_KEY?.trim() || undefined,
    policy: {
      network,
      tokens: { usdc: USDC[network] },
      perPaymentCap: env.PER_PAYMENT_CAP ?? '50',
      dailyCap: env.DAILY_CAP ?? '100',
    },
  };
}
