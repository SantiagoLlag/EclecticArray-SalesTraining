import type { APIRoute } from 'astro';
import products from '../../data/products.json';
import { dbEnv, dbFetch, readSellerToken, SELLER_COOKIE } from '../../lib/results-db';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One past session, replayed: returns the exact shape renderReport() consumes. Scoped to
// the signed-in seller — you can only reopen your own sessions.
export const GET: APIRoute = async ({ url, cookies }) => {
  const seller = readSellerToken(cookies.get(SELLER_COOKIE)?.value);
  if (!seller) return json({ error: 'Not signed in.' }, 401);
  if (!dbEnv()) return json({ error: 'Results database not configured.' }, 503);

  const id = url.searchParams.get('id') ?? '';
  if (!UUID.test(id)) return json({ error: 'Invalid session id.' }, 400);

  try {
    const res = await dbFetch(
      `/training_sessions?id=eq.${id}&seller_id=eq.${seller.sid}` +
        `&select=report,criteria,transcript,agent_label,mode,product_id,product_name`
    );
    if (!res.ok) throw new Error(`query failed: ${res.status}`);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    if (!rows.length) return json({ error: 'Session not found.' }, 404);
    const row = rows[0];
    const price =
      (products as Array<{ id: string; price: string }>).find((p) => p.id === row.product_id)
        ?.price ?? '';
    return json({
      report: row.report,
      criteria: row.criteria ?? [],
      transcript: row.transcript ?? [],
      customer: row.agent_label,
      mode: row.mode,
      product: row.mode === 'inventory' ? null : { name: row.product_name ?? '', price },
    });
  } catch (err) {
    console.error('[my-session]', err);
    return json({ error: 'Could not load that session.' }, 502);
  }
};
