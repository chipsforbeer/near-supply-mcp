export type OpErrorCode =
  | 'unknown_operation'
  | 'forbidden'
  | 'invalid_arguments'
  | 'not_found'
  | 'conflict'
  | 'request_key_reused'
  | 'revision_mismatch'
  | 'unavailable'
  | 'limit_exceeded'
  | 'internal';

export class OpError extends Error {
  readonly code: OpErrorCode;
  readonly details: unknown;
  constructor(code: OpErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export type PublicError = { code: OpErrorCode; message: string; details?: unknown };

// What callers see: constant text for unexpected errors, no stack traces or SQL.
export function publicError(e: unknown): PublicError {
  if (e instanceof OpError) {
    return e.details === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, details: e.details };
  }
  return { code: 'internal', message: 'Operation failed; details withheld.' };
}
