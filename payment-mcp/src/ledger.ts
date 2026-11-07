// Local, durable record of every payment attempt. This file is the double-payment guard together
// with the supplier server's payment_status: never delete it while a payment is open.
//
// state machine for one attempt (one per PO instruction):
//   instructing → instructed → signed → broadcast → settled_ok | settled_failed → recorded
//                     └→ refused (policy) ───────────────────────────────────────┘
//   instructing → aborted (the server refused to instruct; nothing is open on its side)

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type AttemptState =
  | 'instructing'
  | 'instructed'
  | 'refused'
  | 'signed'
  | 'broadcast'
  | 'settled_ok'
  | 'settled_failed'
  | 'recorded'
  | 'aborted';

export type Attempt = {
  po_id: string;
  attempt: number;
  state: AttemptState;
  rail: string | null;
  instruction: string | null; // JSON as returned by po_payment_instruction
  amount: string | null;
  currency: string | null;
  tx_ref: string | null;
  tx_payload: string | null; // signed tx, kept so a crash can re-send the identical tx
  outcome: 'paid' | 'failed' | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export const CLOSED: AttemptState[] = ['recorded', 'aborted'];

export class Ledger {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS attempt (
        po_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        state TEXT NOT NULL,
        rail TEXT,
        instruction TEXT,
        amount TEXT,
        currency TEXT,
        tx_ref TEXT,
        tx_payload TEXT,
        outcome TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (po_id, attempt)
      );
      CREATE TABLE IF NOT EXISTS event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        state TEXT NOT NULL,
        detail TEXT,
        at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  latest(poId: string): Attempt | undefined {
    return this.db.prepare('SELECT * FROM attempt WHERE po_id = ? ORDER BY attempt DESC LIMIT 1').get(poId) as Attempt | undefined;
  }

  history(poId: string): Attempt[] {
    return this.db.prepare('SELECT * FROM attempt WHERE po_id = ? ORDER BY attempt').all(poId) as Attempt[];
  }

  open(): Attempt[] {
    return this.db
      .prepare(`SELECT * FROM attempt WHERE state NOT IN (${CLOSED.map(() => '?').join(',')}) ORDER BY created_at`)
      .all(...CLOSED) as Attempt[];
  }

  /** Start the next attempt for a PO. Throws if one is still open. */
  begin(poId: string): Attempt {
    const last = this.latest(poId);
    if (last && !CLOSED.includes(last.state)) throw new Error(`PO ${poId} already has open attempt ${last.attempt} (${last.state}).`);
    const n = (last?.attempt ?? 0) + 1;
    this.db.prepare(`INSERT INTO attempt (po_id, attempt, state) VALUES (?, ?, 'instructing')`).run(poId, n);
    this.log(poId, n, 'instructing');
    return this.latest(poId)!;
  }

  update(a: Pick<Attempt, 'po_id' | 'attempt'>, state: AttemptState, fields: Partial<Omit<Attempt, 'po_id' | 'attempt' | 'state'>> = {}, detail?: string): Attempt {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    const sets = ['state = ?', "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')", ...keys.map((k) => `${k} = ?`)];
    const vals = [state, ...keys.map((k) => fields[k] ?? null)] as (string | number | null)[];
    this.db.prepare(`UPDATE attempt SET ${sets.join(', ')} WHERE po_id = ? AND attempt = ?`).run(...vals, a.po_id, a.attempt);
    this.log(a.po_id, a.attempt, state, detail);
    return this.db.prepare('SELECT * FROM attempt WHERE po_id = ? AND attempt = ?').get(a.po_id, a.attempt) as Attempt;
  }

  /** Amounts paid (or possibly paid: signed/broadcast) since 00:00 UTC, in one currency. */
  committedToday(currency: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT amount FROM attempt WHERE currency = ? AND amount IS NOT NULL
           AND state IN ('signed','broadcast','settled_ok','recorded') AND (state <> 'recorded' OR outcome = 'paid')
           AND updated_at >= strftime('%Y-%m-%dT00:00:00.000Z','now')`,
      )
      .all(currency) as { amount: string }[];
    return rows.map((r) => r.amount);
  }

  private log(poId: string, attempt: number, state: string, detail?: string) {
    this.db.prepare('INSERT INTO event (po_id, attempt, state, detail) VALUES (?, ?, ?, ?)').run(poId, attempt, state, detail ?? null);
  }

  close() {
    this.db.close();
  }
}
