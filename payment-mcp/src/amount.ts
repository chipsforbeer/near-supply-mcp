// Exact decimal amounts. The supplier server sends amounts as Postgres numeric(20,6) strings
// ("4232.000000"); tokens count in integer base units. No floats anywhere on the money path.

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

export class AmountError extends Error {}

function parts(amount: string): { whole: string; frac: string } {
  const m = DECIMAL.exec(amount.trim());
  if (!m) throw new AmountError(`Not a non-negative decimal amount: ${JSON.stringify(amount)}`);
  return { whole: m[1]!, frac: m[2] ?? '' };
}

/** Decimal string -> base units. Refuses precision the token cannot represent (never rounds). */
export function toUnits(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new AmountError(`Bad token decimals: ${decimals}`);
  const { whole, frac } = parts(amount);
  const kept = frac.slice(0, decimals);
  const dropped = frac.slice(decimals);
  if (/[1-9]/.test(dropped)) {
    throw new AmountError(`${amount} has more than ${decimals} decimal places; refusing to round a payment.`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(kept.padEnd(decimals, '0') || '0');
}

/** Base units -> shortest decimal string. */
export function fromUnits(units: bigint, decimals: number): string {
  if (units < 0n) throw new AmountError('Negative amount.');
  const s = units.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

const SCALE = 18; // comparison/sum precision; well above numeric(20,6)

/** Compare two decimal strings exactly: -1, 0 or 1. */
export function cmp(a: string, b: string): -1 | 0 | 1 {
  const x = toUnits(a, SCALE);
  const y = toUnits(b, SCALE);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Exact sum of decimal strings. */
export function add(...xs: string[]): string {
  return fromUnits(xs.reduce((acc, x) => acc + toUnits(x, SCALE), 0n), SCALE);
}
