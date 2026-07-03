import type { APIRoute } from 'astro';
import { dbEnv, dbFetch, readSellerToken, SELLER_COOKIE } from '../../lib/results-db';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The signed-in seller's own record: aggregate stats, recent sessions (light fields only —
// the full report is fetched per-session via /api/my-session), and recent quiz runs.
export const GET: APIRoute = async ({ cookies }) => {
  const seller = readSellerToken(cookies.get(SELLER_COOKIE)?.value);
  if (!seller) return json({ error: 'Not signed in.' }, 401);
  if (!dbEnv()) return json({ error: 'Results database not configured.' }, 503);

  try {
    const [statsRes, sessionsRes, quizzesRes] = await Promise.all([
      dbFetch(`/seller_stats?seller_id=eq.${seller.sid}`),
      dbFetch(
        `/training_sessions?seller_id=eq.${seller.sid}` +
          `&select=id,created_at,mode,mystery,agent_label,product_name,outcome,ticket_amount,` +
          `story_covered,story_total,criteria_passed,criteria_total,` +
          `improvements:report->improvements,emulate:report->emulate` +
          `&order=created_at.desc&limit=50`
      ),
      dbFetch(
        `/quiz_runs?seller_id=eq.${seller.sid}&select=score,total,created_at&order=created_at.desc&limit=10`
      ),
    ]);
    if (!statsRes.ok || !sessionsRes.ok || !quizzesRes.ok) {
      throw new Error(
        `progress queries failed: ${statsRes.status}/${sessionsRes.status}/${quizzesRes.status}`
      );
    }
    const stats = ((await statsRes.json()) as unknown[])[0] ?? null;
    return json({
      seller: { id: seller.sid, name: seller.name },
      stats,
      sessions: await sessionsRes.json(),
      quizzes: await quizzesRes.json(),
    });
  } catch (err) {
    console.error('[my-progress]', err);
    return json({ error: 'Could not load your progress.' }, 502);
  }
};
