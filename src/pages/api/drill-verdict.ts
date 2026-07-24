import type { APIRoute } from 'astro';
import Anthropic from '@anthropic-ai/sdk';
import products from '../../data/products.json';
import stores from '../../data/stores.json';
import drills from '../../data/drills.json';
import { dbEnv, dbFetch, readSellerToken, SELLER_COOKIE } from '../../lib/results-db';

export const prerender = false;

// A drill rep is graded by a lean verdict — pass/retry + one coaching line + one quote —
// NOT the full /api/report shape. The client sends {conversationId, drillId, store}; the
// piece, its true story, and the transcript are read back from the ElevenLabs conversation
// so the verdict can't be fed a fake context.

// process.env first: on Vercel it's the runtime source of truth; import.meta.env
// covers astro dev. Empty/whitespace values count as missing.
const env = (key: string): string | undefined => {
  const value = process.env[key] ?? (import.meta.env[key] as string | undefined);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};

type Drill = { id: string; agent_id: string | null; label: string; pass_line: string };

// Same readiness rule as the client's isConfigured (app.js:12-13): a real id, not a placeholder.
const isConfigured = (id: unknown): id is string =>
  typeof id === 'string' && id.length >= 10 && !/todo|placeholder|xxx|[<>]/i.test(id);

// The set of agent ids that belong to a configured drill — the allowlist for this route.
// A persona conversation never lands here (its agent isn't a drill agent); a drill
// conversation posted to /api/report is rejected there (its agent isn't in agents.json).
const DRILL_AGENT_IDS = new Set(
  (drills as Drill[]).filter((d) => isConfigured(d.agent_id)).map((d) => d.agent_id)
);

// Strict, minimal output — the whole product of a rep is these three fields.
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['result', 'fix', 'quote'],
  properties: {
    result: { type: 'string', enum: ['pass', 'retry'] },
    fix: { type: 'string', maxLength: 220 },
    quote: { type: 'string', maxLength: 220 },
  },
} as const;

// Shared grading philosophy: this is a two-minute REHEARSAL rep, not an exam. Reward good
// form under repetition; a fabricated product fact never passes.
const GRADER_PHILOSOPHY = `You grade ONE short sales-rehearsal drill for Eclectic Array, a fair-trade B-Corp boutique selling handcrafted Mexican pieces. The AI played the customer; grade ONLY the seller's lines (labeled "Seller"), never the customer's. This is a two-minute rehearsal rep, not an exam — reward good FORM under repetition; a clean, well-formed attempt passes even if brief. Judge against the pass line and the piece's TRUE story provided; a fabricated product fact never passes. Return: result ('pass' or 'retry'), fix (one imperative coaching line, <=220 chars), and quote (the single most telling seller line verbatim — or, on a retry, the moment to fix; empty quote allowed).`;

// Per-drill grading instruction, keyed by drillId. Each anchored to the drill's pass_line.
const DRILL_PROMPTS: Record<string, string> = {
  objection: `${GRADER_PHILOSOPHY}

This is the OBJECTION drill. Pass when the seller answered the specific objection the customer raised with concrete, TRUE substance — real facts, specifics, comparisons, or genuine reassurance consistent with the piece's true story — and did NOT reach for a reflex or unprompted discount as the answer, and invented nothing. Retry if they deflected, dismissed, or ignored the objection, answered with a discount instead of substance, or stated anything that contradicts or fabricates beyond the true story.`,
  price: `${GRADER_PHILOSOPHY}

This is the PRICE-DEFENSE drill. Pass when the seller conceded NOTHING beyond 10% off AND made a concrete value case for THIS piece (craft, provenance, rarity, quality — grounded in the true story) rather than defending with a bare "that's the price." Retry on any concession past 10%, an invented authority or giveaway to close, or caving to the customer's number without a value case.`,
  story: `${GRADER_PHILOSOPHY}

This is the STORY-SPRINT drill. Pass when, in a roughly 60-90 second telling, the seller covered the piece's key beats (what it is, where/who it comes from, and what makes it special) grounded in the true story, answered the customer's single probe, and invented NOTHING (paraphrase is fine; an honest "I'm not sure" is fine). Retry if a key beat is missing, the probe was dodged, or any stated fact contradicts or fabricates beyond the true story.`,
  close: `${GRADER_PHILOSOPHY}

This is the CLOSE drill. Pass when the seller made a clear, natural ask for the sale — an unambiguous invitation to buy, ring it up, or take it home — after acknowledging the customer's hesitation, delivered without pushiness, and invented no product facts. Retry if they never asked, only hinted, asked in a forced or aggressive way, or fabricated a claim to push the sale.`,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const POST: APIRoute = async ({ request, cookies }) => {
  const elevenKey = env('ELEVENLABS_API_KEY');
  const anthropicKey = env('ANTHROPIC_API_KEY');
  if (!elevenKey || !anthropicKey) {
    const missing = [
      !elevenKey && 'ELEVENLABS_API_KEY',
      !anthropicKey && 'ANTHROPIC_API_KEY',
    ]
      .filter(Boolean)
      .join(', ');
    console.error(`[drill-verdict] missing env: ${missing}`);
    return json({ error: `Server is missing: ${missing}.` }, 500);
  }

  let conversationId: unknown;
  let drillId: unknown;
  let storeFlag: unknown;
  try {
    ({ conversationId, drillId, store: storeFlag } = await request.json());
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  if (typeof conversationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(conversationId)) {
    return json({ error: 'Invalid conversationId.' }, 400);
  }
  // The drill named in the body must be a real, configured drill.
  const drill = (drills as Drill[]).find((d) => d.id === drillId);
  if (!drill || !isConfigured(drill.agent_id)) {
    return json({ error: 'Unknown drill.' }, 400);
  }
  // The tablet's selected store rides along for analytics; only known ids are kept.
  const sessionStore =
    typeof storeFlag === 'string' &&
    (stores as Array<{ id: string }>).some((s) => s.id === storeFlag)
      ? storeFlag
      : null;

  // 1 · Fetch the conversation from ElevenLabs
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
    { headers: { 'xi-api-key': elevenKey } }
  );
  if (resp.status === 404) return json({ error: 'Conversation not found.' }, 404);
  if (!resp.ok) return json({ error: `ElevenLabs returned ${resp.status}.` }, 502);
  const conversation = await resp.json();

  // The conversation must belong to a configured drill agent AND to the drill named in the
  // body — a persona conversation, or a different drill's conversation, is rejected here.
  if (!DRILL_AGENT_IDS.has(conversation.agent_id) || conversation.agent_id !== drill.agent_id) {
    return json({ error: 'Conversation does not belong to this drill.' }, 403);
  }

  // ElevenLabs needs a few seconds after the call to finish processing.
  if (conversation.status !== 'done' && conversation.status !== 'failed') {
    return json({ status: 'processing' }, 202);
  }

  // Transcript: the agent is the customer in every drill, the human is the seller.
  const turns = (conversation.transcript ?? [])
    .filter((t: { message?: string }) => t?.message)
    .map((t: { role: string; message: string }) => ({
      label: t.role === 'agent' ? 'Customer' : 'Seller',
      message: t.message,
    }));
  if (turns.length === 0) {
    return json({ error: 'No transcript was recorded.' }, 422);
  }
  const transcriptText = turns
    .map((t: { label: string; message: string }) => `${t.label}: ${t.message}`)
    .join('\n');

  const vars: Record<string, string> =
    conversation.conversation_initiation_client_data?.dynamic_variables ?? {};

  // The agent's automated evaluation criteria — a corroborating signal for the grader.
  type RawCriterion = { criteria_id?: string; result?: string; rationale?: string };
  const rawCriteria: RawCriterion[] =
    conversation.analysis?.evaluation_criteria_results_list ??
    Object.values(conversation.analysis?.evaluation_criteria_results ?? {});
  const criteriaText = rawCriteria
    .filter((c) => c?.criteria_id)
    .map((c) => `- ${c.criteria_id}: ${(c.result ?? 'unknown').toUpperCase()} — ${c.rationale ?? ''}`)
    .join('\n') || '(none configured)';

  const userContent = `Drill: ${drill.label}. What passes: ${drill.pass_line}

Reference TRUE story of the piece (the seller must not contradict it or invent beyond it):
${vars.product_story ?? '(not provided)'}

Known customer concerns for this piece:
${vars.product_objections ?? '(not provided)'}

Automated evaluation criteria for this rep (corroborating signal — judge the transcript yourself):
${criteriaText}

Transcript:
${transcriptText}`;

  // 2 · Grade it with Claude (structured output → no parsing surprises)
  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const message = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4000,
    output_config: {
      format: { type: 'json_schema', schema: VERDICT_SCHEMA },
    },
    system: DRILL_PROMPTS[drill.id],
    messages: [{ role: 'user', content: userContent }],
  });

  const text = message.content.find((b) => b.type === 'text')?.text ?? '';
  let verdict: { result: string; fix: string; quote: string };
  try {
    verdict = JSON.parse(text);
  } catch {
    return json({ error: 'The verdict came back malformed. Try again.' }, 502);
  }
  const { result, fix, quote } = verdict;

  // Persist the rep for the signed-in seller (kiosk cookie). Guests and an unconfigured
  // database are both fine — persistence must never break the verdict, which we always
  // return. conversation_id is unique, so a re-grade updates in place instead of duplicating.
  try {
    const seller = readSellerToken(cookies.get(SELLER_COOKIE)?.value);
    if (seller && dbEnv()) {
      const product_id =
        (products as Array<{ id: string; name: string }>).find(
          (p) => p.name === vars.product_name
        )?.id ?? null;
      const duration_secs =
        typeof conversation.metadata?.call_duration_secs === 'number'
          ? Math.round(conversation.metadata.call_duration_secs)
          : null;
      const row = {
        seller_id: seller.sid,
        conversation_id: conversationId,
        drill_id: drill.id,
        product_id,
        store: sessionStore,
        result,
        fix: String(fix ?? '').slice(0, 220),
        duration_secs,
      };
      const saved = await dbFetch('/drill_runs?on_conflict=conversation_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(row),
      });
      if (!saved.ok) console.error('[drill-verdict] persist failed:', saved.status, await saved.text());
    }
  } catch (err) {
    console.error('[drill-verdict] persist error:', err);
  }

  return json({ result, fix, quote });
};
