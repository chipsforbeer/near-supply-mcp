import type pg from 'pg';
import type { z } from 'zod';
import type { Config } from '../config.ts';
import type { Db } from '../db/pool.ts';

export type Scope = 'read' | 'write' | 'approve';
export type Client = 'bridge' | 'direct' | 'http' | 'test' | 'system';

export type Session = {
  userId: string;
  companyId: string;
  sessionId: string;
  scopes: Scope[];
  client: Client;
};

export type OpContext = {
  db: Db;
  cfg: Config;
  session: Session;
  toolAuditId: string;
  // The write's own reason (writes only), for operations that keep their own history.
  reason?: string;
};

export type OpKind = 'read' | 'write';

export type OpDef<I extends z.ZodObject, O> = {
  name: string;
  summary: string;
  kind: OpKind;
  scope: Scope;
  input: I;
  // Hidden operations are used by the server itself and are never offered to the sandbox.
  hidden?: boolean;
  handler: (args: z.infer<I>, tx: pg.PoolClient, ctx: OpContext) => Promise<O>;
};

// True when a person is not typing the call directly: agents through MCP or HTTP.
export function viaAgent(session: Session): boolean {
  return session.client === 'bridge' || session.client === 'direct' || session.client === 'http';
}
