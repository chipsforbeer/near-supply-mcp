import type { z } from 'zod';
import type { OpDef } from './types.ts';

const NAME = /^[a-z][a-z0-9_]{2,60}$/;

// Identity function that pins the handler's argument type to the schema.
export function defineOp<I extends z.ZodObject, O>(def: OpDef<I, O>): OpDef<I, O> {
  if (!NAME.test(def.name)) throw new Error(`Invalid operation name: ${def.name}`);
  // Reads need read, or approve for sensitive ones (who has access); never write.
  if (def.kind === 'read' && def.scope === 'write') throw new Error(`Read operation ${def.name} must use the read or approve scope.`);
  return def;
}
