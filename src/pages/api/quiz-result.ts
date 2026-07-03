import type { APIRoute } from 'astro';
import { dbEnv, dbFetch, readSellerToken, SELLER_COOKIE } from '../../lib/results-db';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Persists one Inventory Quiz run for the signed-in seller. Guests aren't tracked.
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!dbEnv()) return json({ saved: false }, 200);
  const seller = readSellerToken(cookies.get(SELLER_COOKIE)?.value);
  if (!seller) return json({ saved: false }, 200);

  let score: unknown, total: unknown, missed: unknown;
  try {
    ({ score, total, missed } = await request.json());
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  if (
    !Number.isInteger(score) ||
    !Number.isInteger(total) ||
    (score as number) < 0 ||
    (total as number) < 1 ||
    (score as number) > (total as number) ||
    (total as number) > 500
  ) {
    return json({ error: 'Invalid score.' }, 400);
  }
  const missedClean = Array.isArray(missed)
    ? missed.slice(0, 100).map((m) => ({
        product: String(m?.product ?? '').slice(0, 200),
        answer: String(m?.answer ?? '').slice(0, 300),
      }))
    : [];

  try {
    const res = await dbFetch('/quiz_runs', {
      method: 'POST',
      body: JSON.stringify({ seller_id: seller.sid, score, total, missed: missedClean }),
    });
    if (!res.ok) throw new Error(`insert failed: ${res.status}`);
    return json({ saved: true });
  } catch (err) {
    console.error('[quiz-result]', err);
    return json({ saved: false }, 200); // never break the quiz over persistence
  }
};
