import { z } from 'zod';

// Shape returned by the supplier server's po_payment_instruction
// (teammate repo: src/ops/procurement/po-payment.ts). Parsed strictly so a changed contract fails loudly.
export const PaymentInstruction = z.object({
  po_id: z.uuid(),
  po_code: z.string().min(1),
  supplier_name: z.string(),
  network: z.string(),
  account_id: z.string().min(2).max(64),
  token: z.string().min(1),
  amount: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  approval: z.object({
    approved_by: z.string().nullable(),
    approved_at: z.string(),
    approved_max_amount: z.string().nullable(),
  }),
});
export type PaymentInstruction = z.infer<typeof PaymentInstruction>;
