// Exact decimal arithmetic for quantities and money: BigInt scaled by 10^12.
// Never use JavaScript floating point for stock or prices.

export type Dec = bigint;

const SCALE = 12;
const ONE = 10n ** BigInt(SCALE);
const PLAIN = /^([+-]?)(\d+)(?:\.(\d+))?$/;

function roundDiv(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('Division by zero.');
  const negative = n < 0n !== d < 0n;
  const a = n < 0n ? -n : n;
  const b = d < 0n ? -d : d;
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n; // half away from zero
  return negative ? -q : q;
}

export function dec(value: string | number | bigint): Dec {
  if (typeof value === 'bigint') return value * ONE;
  const s = typeof value === 'number' ? String(value) : value.trim();
  const m = s.match(PLAIN);
  if (!m) throw new RangeError(`Not a plain decimal number: ${s}`);
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = BigInt(m[2]!);
  const frac = m[3] ?? '';
  let scaled: bigint;
  if (frac.length <= SCALE) {
    scaled = whole * ONE + BigInt(frac.padEnd(SCALE, '0') || '0');
  } else {
    const extra = 10n ** BigInt(frac.length - SCALE);
    scaled = whole * ONE + roundDiv(BigInt(frac), extra);
  }
  return sign * scaled;
}

export function isDecimalString(s: string): boolean {
  return PLAIN.test(s.trim());
}

// Rounded to `places` (half away from zero), trailing zeros removed: "439.04", "600".
export function str(d: Dec, places = 6): string {
  const step = 10n ** BigInt(SCALE - places);
  const r = roundDiv(d, step);
  const negative = r < 0n;
  const abs = negative ? -r : r;
  const base = 10n ** BigInt(places);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(places, '0').replace(/0+$/, '');
  if (places === 0) frac = '';
  const text = frac ? `${whole}.${frac}` : `${whole}`;
  return negative && text !== '0' ? `-${text}` : text;
}

export const add = (a: Dec, b: Dec): Dec => a + b;
export const sub = (a: Dec, b: Dec): Dec => a - b;
export const neg = (a: Dec): Dec => -a;
export const mul = (a: Dec, b: Dec): Dec => roundDiv(a * b, ONE);
export const div = (a: Dec, b: Dec): Dec => roundDiv(a * ONE, b);
export const cmp = (a: Dec, b: Dec): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);
export const isZero = (a: Dec): boolean => a === 0n;
export const ZERO: Dec = 0n;

// Whole number of b that fit in a (a, b > 0).
export function floorCount(a: Dec, b: Dec): bigint {
  if (b <= 0n) throw new RangeError('Divisor must be positive.');
  return a / b;
}

// Smallest whole number n with n x b >= a (a >= 0, b > 0).
export function ceilCount(a: Dec, b: Dec): bigint {
  if (b <= 0n) throw new RangeError('Divisor must be positive.');
  if (a <= 0n) return 0n;
  return (a + b - 1n) / b;
}

export function times(a: Dec, n: bigint): Dec {
  return a * n;
}
