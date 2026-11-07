import { z } from 'zod';
import { defineOp } from '../define.ts';
import { requireRfq } from '../procurement/common.ts';

export default defineOp({
  name: 'outreach_status',
  summary: 'For one RFQ: every supplier asked, their status (to_contact, contacted, replied, quoted...), follow-ups, and how many days they have been silent.',
  kind: 'read',
  scope: 'read',
  input: z.object({ rfq_id: z.uuid() }).strict(),
  async handler(args, tx) {
    const rfq = await requireRfq(tx, args.rfq_id);
    const r = await tx.query(
      `SELECT rr.supplier_id, s.name AS supplier, rr.contact_id, c.full_name AS contact, rr.status, rr.first_contacted_at,
              rr.last_contacted_at, rr.last_reply_at, rr.follow_ups, rr.status_note,
              CASE WHEN rr.status = 'contacted' AND rr.last_contacted_at IS NOT NULL
                   THEN greatest(0, floor(extract(epoch FROM now() - rr.last_contacted_at) / 86400))::int END AS days_silent
         FROM rfq_recipient rr JOIN supplier s ON s.id = rr.supplier_id LEFT JOIN contact c ON c.id = rr.contact_id
        WHERE rr.rfq_id = $1 ORDER BY s.name`,
      [rfq.id],
    );
    const counts: Record<string, number> = {};
    for (const row of r.rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return { rfq_code: rfq.rfq_code, rfq_status: rfq.status, counts, recipients: r.rows };
  },
});
