import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { sequential } from '../../db/pool.ts';

function mask(accountId: string): string {
  return accountId.length <= 6 ? accountId : `...${accountId.slice(-6)}`;
}

export default defineOp({
  name: 'supplier_get',
  summary:
    'Everything about one supplier: details (including tax and registration numbers), addresses, contacts with how to reach them, ' +
    'what they sell us, what they offer in general, payout account (masked), recent interactions.',
  kind: 'read',
  scope: 'read',
  input: z.object({ supplier_id: z.uuid() }).strict(),
  async handler(args, tx) {
    const s = await tx.query('SELECT * FROM supplier WHERE id = $1', [args.supplier_id]);
    if (!s.rows[0]) throw new OpError('not_found', 'Supplier not found.');
    const { company_id: _c, name_norm: _n, ...supplier } = s.rows[0];
    const [addresses, contacts, methods, items, payout, interactions, offerings] = await sequential([
      () => tx.query('SELECT kind, lines, city, region, postal_code, country_code FROM supplier_address WHERE supplier_id = $1', [supplier.id]),
      () => tx.query(
        `SELECT id, full_name, job_title, department, is_primary, handles, language, timezone, may_contact_on_behalf, status, notes
           FROM contact WHERE supplier_id = $1 ORDER BY is_primary DESC, full_name`,
        [supplier.id],
      ),
      () => tx.query(
        `SELECT id, contact_id, type_code AS type, value, label, is_preferred, do_not_contact, verified_at
           FROM contact_method WHERE supplier_id = $1 AND removed_at IS NULL ORDER BY is_preferred DESC, type_code`,
        [supplier.id],
      ),
      () => tx.query(
        `SELECT si.id, si.item_id, i.sku, i.name, i.base_uom, si.supplier_sku, si.supplier_item_name, p.name AS purchase_pack,
                si.moq_base, si.lead_time_days, si.last_price, si.last_price_per, si.last_price_currency, si.last_priced_at, si.is_preferred
           FROM supplier_item si JOIN item i ON i.id = si.item_id LEFT JOIN item_pack p ON p.id = si.purchase_pack_id
          WHERE si.supplier_id = $1 ORDER BY i.sku`,
        [supplier.id],
      ),
      () => tx.query(
        `SELECT network, account_id, token, set_at FROM supplier_payout_account
          WHERE supplier_id = $1 AND superseded_at IS NULL`,
        [supplier.id],
      ),
      () => tx.query(
        `SELECT i.id, i.occurred_at, i.direction, i.channel, i.purpose, i.our_address, i.their_address, i.subject, i.summary,
                r.rfq_code, c.full_name AS contact
           FROM interaction i LEFT JOIN rfq r ON r.id = i.rfq_id LEFT JOIN contact c ON c.id = i.contact_id
          WHERE i.supplier_id = $1 ORDER BY i.occurred_at DESC LIMIT 20`,
        [supplier.id],
      ),
      () => tx.query(
        `SELECT id AS offering_id, kind, category, description, tags, min_order, lead_time_days_min, lead_time_days_max,
                price_note, source, document_id, status, updated_at
           FROM supplier_offering WHERE supplier_id = $1 ORDER BY status = 'active' DESC, category`,
        [supplier.id],
      ),
    ]);
    return {
      ...supplier,
      addresses: addresses.rows,
      contacts: contacts.rows.map((c) => ({ ...c, methods: methods.rows.filter((m) => m.contact_id === c.id) })),
      company_methods: methods.rows.filter((m) => m.contact_id === null),
      items: items.rows,
      payout_accounts: payout.rows.map((p) => ({ ...p, account_id: mask(p.account_id) })),
      recent_interactions: interactions.rows,
      offerings: offerings.rows,
    };
  },
});
