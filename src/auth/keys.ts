import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// API keys are shown once at issue and stored only as an HMAC.
export function generateApiKey(): string {
  return `sik_${randomBytes(32).toString('base64url')}`;
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const API_KEY_PATTERN = /^sik_[A-Za-z0-9_-]{43}$/;
