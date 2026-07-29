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

// Strict, minimal output. Beyond the original three fields, two coaching lists ride along:
// what documented story the seller left unused, and what she claimed that our sheet can't
// confirm (to verify — NOT to punish; see the philosophy below).
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['result', 'fix', 'quote', 'missing', 'verify'],
  properties: {
    result: { type: 'string', enum: ['pass', 'retry'] },
    fix: { type: 'string', maxLength: 220 },
    quote: { type: 'string', maxLength: 220 },
    missing: {
      type: 'array',
      items: { type: 'string', maxLength: 120 },
      description: 'Documented story beats the seller did NOT use — short phrases; empty if she used them all',
    },
    verify: {
      type: 'array',
      items: { type: 'string', maxLength: 160 },
      description: "Product claims the seller made that are NOT in the documented story and don't contradict it — phrased for her to verify; empty if none",
    },
  },
} as const;

// Shared grading philosophy: this is a two-minute REHEARSAL rep, not an exam. The documented
// story is a REFERENCE, not the complete truth — sellers live with these pieces and often know
// true facts we haven't written down yet. So: a claim that CONTRADICTS the documented story, or
// a story that collapses into vague, incoherent filler, fails; a plausible, coherent claim
// beyond the documented story does NOT fail — it goes to the "verify" list instead.
const GRADER_PHILOSOPHY = `You grade ONE short sales-rehearsal drill for Eclectic Array, a fair-trade B-Corp boutique selling handcrafted Mexican pieces. The AI played the customer; grade ONLY the seller's lines (labeled "Seller"), never the customer's. This is a two-minute rehearsal rep, not an exam — reward good FORM under repetition; a clean, well-formed attempt passes even if brief.

THE DOCUMENTED STORY IS A REFERENCE, NOT THE COMPLETE TRUTH. Sellers work with these pieces daily and may truthfully know facts our sheet doesn't list. Judge the seller's story on COHERENCE and CREDIBILITY: it must hold together, stay specific, and never CONTRADICT the documented story. A plausible claim beyond the documented story is NOT a fabrication and must NOT cause a retry — record it in "verify" so the seller can confirm it before using it with real customers. What DOES fail: contradicting a documented fact (that we know is wrong), or a story that is vague, generic, or self-contradicting.

Return: result ('pass' or 'retry'); fix (one imperative coaching line, <=220 chars); quote (the single most telling seller line verbatim — or, on a retry, the moment to fix; empty allowed); missing (documented story beats she did NOT use, as short phrases — empty if none); verify (claims she made that are beyond the documented story, phrased so she can check them — empty if none).`;

// The improv drill deliberately INVERTS the no-fabrication rule the other four live by. The
// piece is fictional by construction, so invented detail is the whole point — there is no
// "true story" to check against and no product vars to read. It therefore does NOT reuse
// GRADER_PHILOSOPHY (which anchors to a true story and fails any fabricated fact); it carries
// its own framing and grades three FORM dimensions instead. Keeping it separate leaves the
// four product-drill prompts untouched.
const IMPROV_PROMPT = `You grade ONE short sales-IMPROVISATION drill for Eclectic Array, a fair-trade B-Corp boutique selling handcrafted Mexican pieces. The AI played a delighted, curious customer asking about a piece that DOES NOT EXIST; grade ONLY the seller's lines (labeled "Seller"), never the customer's. This is a two-minute rehearsal rep, not an exam.

THE PIECE IS FICTIONAL BY DESIGN. The customer invented it on the spot and asked the seller to improvise its story. Invented facts are EXPECTED here and are NEVER a failure — do NOT penalize the seller for fabrication, and do NOT check any claim against a "true story" (there is none). What DOES fail is a story that is absent, generic, or self-contradicting.

Grade the seller on THREE dimensions:
- FLUIDITY — momentum and composure: no freezing, no dead-air spirals, and no breaking the game. Saying "we don't have that" or "I don't actually know this piece" AFTER the customer's warm nudge is breaking the game and counts as a FLUIDITY failure. The seller should recover smoothly on every probe.
- CREATIVITY — specific, vivid, original detail: a named maker or place, a real technique, a reason why — never generic mush like "it's handmade, very special."
- CREDIBILITY — INTERNAL coherence of the invented story: origin, maker, price, and technique must not self-contradict across follow-ups (the customer runs a deliberate echo-check, repeating a detail back to test it), and the register must stay plausible for a Mexican artisan boutique.

result: 'pass' ONLY when all three dimensions land at conversational quality; 'retry' otherwise. fix: one imperative coaching line (<=220 chars) that names the WEAKEST dimension and the moment it cracked. quote: the single most telling seller line, verbatim (empty allowed). missing and verify: ALWAYS return empty arrays in this drill — there is no documented story to miss or verify.`;

// Per-drill grading instruction, keyed by drillId. Each anchored to the drill's pass_line.
const DRILL_PROMPTS: Record<string, string> = {
  objection: `${GRADER_PHILOSOPHY}

This is the OBJECTION drill. Pass when the seller answered the specific objection the customer raised with a coherent, credible story: concrete substance — facts, specifics, comparisons, or genuine reassurance — that never contradicts the documented story, and did NOT reach for a reflex or unprompted discount as the answer. Substance beyond the documented story counts, and goes to "verify". Retry if they deflected, dismissed, or ignored the objection, answered with a discount instead of substance, contradicted a documented fact, or gave only vague, generic filler.`,
  price: `${GRADER_PHILOSOPHY}

This is the PRICE-DEFENSE drill. Pass when the seller conceded NOTHING beyond 10% off AND made a concrete, credible value case for THIS piece (craft, provenance, rarity, quality) that never contradicts the documented story, rather than defending with a bare "that's the price." Retry on any concession past 10%, caving to the customer's number without a value case, contradicting a documented fact, or a value case made of pure generic filler.`,
  story: `${GRADER_PHILOSOPHY}

This is the STORY-SPRINT drill. This drill IS about the documented story: pass when, in a roughly 60-90 second telling that holds together, the seller covered the piece's key documented beats (what it is, where/who it comes from, and what makes it special) and answered the customer's single probe (paraphrase is fine; an honest "I'm not sure" is fine; credible additions beyond the sheet go to "verify", never against her). Retry if a key documented beat is missing, the probe was dodged, a stated fact contradicts the documented story, or the telling is generic mush.`,
  close: `${GRADER_PHILOSOPHY}

This is the CLOSE drill. Pass when the seller made a clear, natural ask for the sale — an unambiguous invitation to buy, ring it up, or take it home — after acknowledging the customer's hesitation, delivered without pushiness and without contradicting the documented story. Retry if they never asked, only hinted, asked in a forced or aggressive way, or leaned on a claim that contradicts the documented story to push the sale. If the CUSTOMER prompted the close herself ("do you want to ring it up for me?") and the seller merely agreed, the seller did NOT perform the ask — that is a retry.`,
  // The improv drill is graded by its own inverted framing — see IMPROV_PROMPT above.
  improv: IMPROV_PROMPT,
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
  // A platform-killed call (quota exceeded, infra error) must never be graded as if the
  // seller failed — the rep didn't happen. Surface it plainly instead.
  if (conversation.status === 'failed') {
    console.error('[drill-verdict] call failed:', conversation.metadata?.termination_reason);
    return json({ error: 'The call dropped mid-rep — not your fault. Run the rep again.' }, 422);
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

  // The improv drill runs WITHOUT a real product: no product_story / product_objections vars
  // are ever sent (the app posts only drill_seed), so its context is the transcript + the
  // agent's evaluation-criteria results alone. Do NOT read product vars on this path.
  const userContent =
    drill.id === 'improv'
      ? `Drill: ${drill.label}. What passes: ${drill.pass_line}

The piece is FICTIONAL — invented by the customer in the moment and improvised by the seller. There is no reference story and no fixed facts; judge fluidity, creativity, and internal credibility from the transcript alone.

Automated evaluation criteria for this rep (corroborating signal — judge the transcript yourself):
${criteriaText}

Transcript:
${transcriptText}`
      : `Drill: ${drill.label}. What passes: ${drill.pass_line}

DOCUMENTED story of the piece (the reference — the seller must never contradict it; credible knowledge beyond it goes to "verify", and documented beats she didn't use go to "missing"):
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
  let verdict: { result: string; fix: string; quote: string; missing?: string[]; verify?: string[] };
  try {
    verdict = JSON.parse(text);
  } catch {
    return json({ error: 'The verdict came back malformed. Try again.' }, 502);
  }
  const { result, fix, quote } = verdict;
  // Coaching lists (empty for improv by design). Clamp defensively; render-side hides empties.
  const missing = Array.isArray(verdict.missing) ? verdict.missing.slice(0, 4).map((s) => String(s).slice(0, 120)) : [];
  const verify = Array.isArray(verdict.verify) ? verdict.verify.slice(0, 4).map((s) => String(s).slice(0, 160)) : [];

  // Persist the rep for the signed-in seller (kiosk cookie). Guests and an unconfigured
  // database are both fine — persistence must never break the verdict, which we always
  // return. conversation_id is unique, so a re-grade updates in place instead of duplicating.
  try {
    const seller = readSellerToken(cookies.get(SELLER_COOKIE)?.value);
    if (seller && dbEnv()) {
      // The improv drill has no real product, so product_id is always null (the column is
      // nullable; drill_id='improv' is just a new text value). Other drills resolve it from
      // the piece's name as before.
      const product_id =
        drill.id === 'improv'
          ? null
          : (products as Array<{ id: string; name: string }>).find(
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
        // Coaching lists (jsonb): what documented story went unused, what to verify.
        missing,
        verify,
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

  return json({ result, fix, quote, missing, verify });
};
