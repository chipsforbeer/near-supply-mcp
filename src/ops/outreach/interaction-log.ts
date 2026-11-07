import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { viaAgent } from '../types.ts';
import { requireSupplier } from '../suppliers/common.ts';
import { linkDocuments } from '../procurement/common.ts';
import { isoDateTime } from '../schemas.ts';

export const CHANNELS = ['email', 'phone', 'whatsapp', 'line', 'wechat', 'telegram', 'sms', 'web_form', 'portal', 'visit', 'video_call', 'other'] as const;
export const PURPOSES = ['rfq', 'follow_up', 'spec_request', 'negotiation', 'order', 'complaint', 'intro', 'other'] as const;

export default defineOp({
  name: 'interaction_log',
  summary:
    'Log every email, call or message with a supplier: direction, channel, which of our addresses and theirs, subject, a short summary, the mail thread id, attachments (document ids). Moves the RFQ recipient to contacted / replied.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      supplier_id: z.uuid(),
      contact_id: z.uuid().optional(),
      contact_method_id: z.uuid().optional(),
      rfq_id: z.uuid().optional(),
      direction: z.enum(['out', 'in']),
      channel: z.enum(CHANNELS),
      purpose: z.enum(PURPOSES).optional(),
      our_address: z.string().max(300).optional(),
      their_address: z.string().max(300).optional(),
      subject: z.string().max(500).optional(),
      summary: z.string().trim().min(1).max(4000),
      external_thread_id: z.string().max(500).optional(),
      occurred_at: isoDateTime,
      document_ids: z.array(z.uuid()).max(30).optional(),
    })
    .strict(),
  async handler(args, tx, ctx) {
    const supplier = await requireSupplier(tx, args.supplier_id);
    if (args.contact_id) {
      const c = await tx.query('SELECT full_name, may_contact_on_behalf FROM contact WHERE id = $1 AND supplier_id = $2', [args.contact_id, supplier.id]);
      if (!c.rows[0]) throw new OpError('not_found', 'Contact not found at that supplier.');
      if (args.direction === 'out' && !c.rows[0].may_contact_on_behalf) {
        throw new OpError('conflict', `${c.rows[0].full_name} must not be contacted on the user's behalf.`);
      }
    }
    if (args.contact_method_id) {
      const m = await tx.query('SELECT do_not_contact, removed_at FROM contact_method WHERE id = $1 AND supplier_id = $2', [args.contact_method_id, supplier.id]);
      if (!m.rows[0]) throw new OpError('not_found', 'Contact method not found at that supplier.');
      if (args.direction === 'out' && m.rows[0].do_not_contact) throw new OpError('conflict', 'That contact method is marked do-not-contact.');
      if (args.direction === 'out' && m.rows[0].removed_at) throw new OpError('conflict', 'That contact method was retired; use a current one.');
    }
    let recipient: { status: string } | undefined;
    if (args.rfq_id) {
      const r = await tx.query('SELECT status FROM rfq_recipient WHERE rfq_id = $1 AND supplier_id = $2 FOR UPDATE', [args.rfq_id, supplier.id]);
      recipient = r.rows[0];
      if (!recipient) throw new OpError('conflict', 'This supplier is not a recipient of that RFQ; add it with rfq_add_recipients first.');
    }

    const i = await tx.query(
      `INSERT INTO interaction (supplier_id, contact_id, contact_method_id, rfq_id, direction, channel, purpose, our_address,
                                their_address, subject, summary, external_thread_id, occurred_at, logged_by, via_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id, occurred_at`,
      [supplier.id, args.contact_id ?? null, args.contact_method_id ?? null, args.rfq_id ?? null, args.direction, args.channel,
        args.purpose ?? null, args.our_address ?? null, args.their_address ?? null, args.subject ?? null, args.summary,
        args.external_thread_id ?? null, args.occurred_at, ctx.session.userId, viaAgent(ctx.session)],
    );
    const interaction = i.rows[0];
    await linkDocuments(tx, args.document_ids, 'interaction', interaction.id, args.direction === 'in' ? 'received attachment' : 'sent attachment');

    if (args.direction === 'out') {
      await tx.query('UPDATE supplier SET last_contacted_at = greatest(coalesce(last_contacted_at, $2), $2) WHERE id = $1', [supplier.id, args.occurred_at]);
    } else {
      await tx.query('UPDATE supplier SET last_reply_at = greatest(coalesce(last_reply_at, $2), $2) WHERE id = $1', [supplier.id, args.occurred_at]);
    }
    let recipientStatus: string | null = null;
    if (args.rfq_id && recipient) {
      if (args.direction === 'out') {
        const r = await tx.query(
          `UPDATE rfq_recipient SET
              status = CASE WHEN status = 'to_contact' THEN 'contacted' ELSE status END,
              follow_ups = CASE WHEN first_contacted_at IS NULL THEN follow_ups ELSE follow_ups + 1 END,
              first_contacted_at = coalesce(first_contacted_at, $3),
              last_contacted_at = $3
            WHERE rfq_id = $1 AND supplier_id = $2 RETURNING status`,
          [args.rfq_id, supplier.id, args.occurred_at],
        );
        recipientStatus = r.rows[0].status;
        await tx.query(`UPDATE rfq SET status = 'sent' WHERE id = $1 AND status = 'draft'`, [args.rfq_id]);
      } else {
        const r = await tx.query(
          `UPDATE rfq_recipient SET
              status = CASE WHEN status IN ('to_contact','contacted','no_response') THEN 'replied' ELSE status END,
              last_reply_at = $3
            WHERE rfq_id = $1 AND supplier_id = $2 RETURNING status`,
          [args.rfq_id, supplier.id, args.occurred_at],
        );
        recipientStatus = r.rows[0].status;
      }
    }
    return { interaction_id: interaction.id, supplier: supplier.name, direction: args.direction, rfq_recipient_status: recipientStatus };
  },
});
