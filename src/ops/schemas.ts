import { z } from 'zod';
import { isDecimalString } from '../domain/decimal.ts';

// Numbers may arrive as JSON numbers or strings; both become plain decimal strings.
function plainNumber(v: number): string {
  if (!Number.isFinite(v) || Math.abs(v) >= 1e15) return 'invalid';
  return Number.isInteger(v) ? String(v) : v.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}

const decimalText = z
  .union([z.number(), z.string().max(40)])
  .transform((v) => (typeof v === 'number' ? plainNumber(v) : v.trim()))
  .refine(isDecimalString, { message: 'Must be a plain decimal number such as 12 or 12.5.' });

export const decimal = decimalText;
export const positiveDecimal = decimalText.refine((v) => !v.startsWith('-') && /[1-9]/.test(v), {
  message: 'Must be greater than zero.',
});
export const nonNegativeDecimal = decimalText.refine((v) => !v.startsWith('-'), { message: 'Must not be negative.' });

export const uomCode = z.string().trim().min(1).max(10);
export const currency = z.string().regex(/^[A-Z]{3}$/, 'Three-letter currency code, for example USD.');
export const siteCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/);
export const locationCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/);
export const isoDate = z.iso.date();
export const isoDateTime = z.iso.datetime({ offset: true });
export const limit = (max: number, dflt: number) => z.number().int().min(1).max(max).default(dflt);

// Quantity entered the way a person says it: a number plus a unit or a pack name.
export const unitFields = {
  uom: uomCode.optional(),
  pack: z.string().trim().min(1).max(120).optional(),
};
