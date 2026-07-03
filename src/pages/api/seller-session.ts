import type { APIRoute } from 'astro';
import { readSellerToken, SELLER_COOKIE } from '../../lib/results-db';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// GET → who is training on this device (or null). DELETE → sign out (back to the roster).
export const GET: APIRoute = async ({ cookies }) => {
  const seller = readSellerToken(cookies.get(SELLER_COOKIE)?.value);
  return json({ seller: seller ? { id: seller.sid, name: seller.name } : null });
};

export const DELETE: APIRoute = async ({ cookies }) => {
  cookies.delete(SELLER_COOKIE, { path: '/' });
  return json({ seller: null });
};
