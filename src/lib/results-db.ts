// Server-only access to the results database (Supabase Postgres via PostgREST) and the
// kiosk seller-session token. All trainer routes go through the service role — the
// database is never exposed to the browser. If the env vars are missing, everything
// degrades gracefully: the trainer keeps working, results just aren't saved.
import { createHmac, timingSafeEqual } from 'node:crypto';

const env = (key: string): string | undefined => {
  const value = process.env[key] ?? (import.meta.env[key] as string | undefined);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};

export const SELLER_COOKIE = 'ea_seller';
const SESSION_HOURS = 12;

export function dbEnv(): { url: string; key: string } | null {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return url && key ? { url, key } : null;
}

export async function dbFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const cfg = dbEnv();
  if (!cfg) throw new Error('results database not configured');
  return fetch(`${cfg.url}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

export async function dbRpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await dbFetch(`/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`rpc ${fn} failed: ${res.status}`);
  return res.json();
}

// ——— Seller session token: HMAC-signed, kept in an httpOnly cookie ———
// The signing key is the service-role key (already secret, server-only), so no extra env.

const sign = (payload: string, key: string) =>
  createHmac('sha256', key).update(payload).digest('base64url');

export function makeSellerToken(sellerId: string, name: string): string | null {
  const cfg = dbEnv();
  if (!cfg) return null;
  const payload = Buffer.from(
    JSON.stringify({ sid: sellerId, name, exp: Date.now() + SESSION_HOURS * 3600_000 })
  ).toString('base64url');
  return `${payload}.${sign(payload, cfg.key)}`;
}

export function readSellerToken(token: string | undefined): { sid: string; name: string } | null {
  const cfg = dbEnv();
  if (!cfg || !token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload, cfg.key);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof data.sid !== 'string' || typeof data.name !== 'string' || Date.now() > data.exp) {
      return null;
    }
    return { sid: data.sid, name: data.name };
  } catch {
    return null;
  }
}
