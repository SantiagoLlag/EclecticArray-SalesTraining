import type { APIRoute } from 'astro';
import { dbEnv, dbFetch, dbRpc, makeSellerToken, SELLER_COOKIE } from '../../lib/results-db';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Kiosk login: the seller taps their name and enters a PIN. The PIN is verified in the
// database (bcrypt); a signed httpOnly cookie carries the seller session for ~12h.
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!dbEnv()) return json({ error: 'Results database not configured.' }, 503);

  let sellerId: unknown, pin: unknown;
  try {
    ({ seller_id: sellerId, pin } = await request.json());
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  if (typeof sellerId !== 'string' || !UUID.test(sellerId)) {
    return json({ error: 'Invalid seller.' }, 400);
  }
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) {
    await sleep(400);
    return json({ error: 'Wrong PIN.' }, 401);
  }

  try {
    const ok = await dbRpc('verify_seller_pin', { p_seller_id: sellerId, p_pin: pin });
    if (ok !== true) {
      await sleep(400); // blunt brute-force friction; PINs are kiosk-grade by design
      return json({ error: 'Wrong PIN.' }, 401);
    }
    const res = await dbFetch(`/sellers?id=eq.${sellerId}&select=id,name`);
    const rows = (await res.json()) as Array<{ id: string; name: string }>;
    if (!rows.length) return json({ error: 'Seller not found.' }, 404);

    const token = makeSellerToken(rows[0].id, rows[0].name);
    if (!token) return json({ error: 'Could not create session.' }, 500);
    cookies.set(SELLER_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: import.meta.env.PROD,
      maxAge: 12 * 3600,
    });
    return json({ seller: rows[0] });
  } catch (err) {
    console.error('[seller-login]', err);
    return json({ error: 'Login failed. Try again.' }, 502);
  }
};
