import type { APIRoute } from 'astro';
import { dbEnv, dbFetch } from '../../lib/results-db';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The kiosk roster: active seller names for the store tablet. Names only — no PINs,
// no stats. If the database isn't configured the trainer falls back to guest mode.
export const GET: APIRoute = async () => {
  if (!dbEnv()) return json({ configured: false, sellers: [] });
  try {
    const res = await dbFetch('/sellers?select=id,name&active=is.true&order=name.asc');
    if (!res.ok) throw new Error(`roster query failed: ${res.status}`);
    const sellers = await res.json();
    return json({ configured: true, sellers });
  } catch (err) {
    console.error('[roster]', err);
    return json({ configured: false, sellers: [] });
  }
};
