import type { APIRoute } from 'astro';
import Anthropic from '@anthropic-ai/sdk';
import agents from '../../data/agents.json';

export const prerender = false;

// The contact surface stays minimal: the client sends only a conversationId.
// Product data and customer type are read back from the ElevenLabs conversation
// (dynamic variables + agent_id), so the report can't be fed a fake context.

// process.env first: on Vercel it's the runtime source of truth; import.meta.env
// covers astro dev. Empty/whitespace values count as missing.
const env = (key: string): string | undefined => {
  const value = process.env[key] ?? (import.meta.env[key] as string | undefined);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome',
    'outcome_quote',
    'ticket',
    'summary',
    'story_coverage',
    'objection_handling',
    'best_moment',
    'improvements',
  ],
  properties: {
    outcome: { type: 'string', enum: ['bought', 'deferred', 'walked', 'incomplete'] },
    ticket: {
      type: 'object',
      additionalProperties: false,
      required: ['amount', 'note'],
      properties: {
        amount: {
          type: 'string',
          description: "Final sale total as a dollar string, e.g. '$240' or '$45.60'; '$0' if no purchase",
        },
        note: {
          type: 'string',
          description: "One short clause explaining the math: 'one pair at full price', 'two at 10% off', 'no sale — customer deferred'",
        },
      },
    },
    outcome_quote: {
      type: 'string',
      description: "The customer's closing line, verbatim from the transcript; empty if cut short",
    },
    summary: {
      type: 'string',
      description: 'Two to three plain-English sentences on how the session went',
    },
    story_coverage: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['point', 'covered', 'note'],
        properties: {
          point: { type: 'string', description: 'One Know-your-piece bullet, shortened' },
          covered: { type: 'boolean' },
          note: { type: 'string', description: 'Max one sentence: quote or comment' },
        },
      },
    },
    objection_handling: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['objection', 'rating', 'note'],
        properties: {
          objection: { type: 'string', description: 'An objection the customer actually raised' },
          rating: { type: 'string', enum: ['strong', 'partial', 'weak'] },
          note: { type: 'string', description: 'Max one sentence on how the seller handled it' },
        },
      },
    },
    best_moment: { type: 'string', description: "The seller's single best line, quoted" },
    improvements: {
      type: 'array',
      items: { type: 'string' },
      description: '2-3 concrete changes for next session, most important first',
    },
  },
} as const;

const SYSTEM_PROMPT = `You are the sales coach for Eclectic Array, a fair-trade B-Corp boutique in Los Cabos and Nevis selling handcrafted Mexican fashion and art. A seller has just finished a voice training session against a simulated customer. Grade the seller (the lines labeled "Seller"), never the customer.

What good selling looks like here: a warm, genuine welcome; discovery (understanding who the customer is) before pitching; telling the TRUE story of the piece unprompted — maker, technique, origin; answering objections with substance instead of discounts; total honesty (inventing facts, e.g. claiming a piece can do something the reference story says it cannot, is a serious failure — check every claim against the reference story); holding the price with warmth; and directly asking for the sale.

Rules for your report:
- ticket: the final sale total in dollars, computed from the transcript — units bought × the product price, minus any discount or extras the seller granted. If the customer did not buy, amount is "$0". The note is one short clause with the math ("two pairs at full price", "one pair with the 5% cash discount", "no sale — customer walked").
- story_coverage: one entry per bullet in the reference "Know your piece" story. covered = true only if the seller actually said it (a paraphrase counts).
- objection_handling: one entry per objection the customer actually raised in the transcript — not the reference list. strong = answered with substance and honesty; partial = answered but thin or partly missed; weak = dodged, caved on price, or invented facts.
- best_moment: the seller's single best line, quoted verbatim.
- improvements: 2-3 concrete, actionable changes for the next session, most important first, referencing what was actually said.
- summary: plain English, direct and kind. outcome_quote must be verbatim from the transcript.
- If the transcript is too short to judge fairly, say so in the summary and use outcome "incomplete".
Write everything in English.`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const POST: APIRoute = async ({ request }) => {
  const elevenKey = env('ELEVENLABS_API_KEY');
  const anthropicKey = env('ANTHROPIC_API_KEY');
  if (!elevenKey || !anthropicKey) {
    const missing = [
      !elevenKey && 'ELEVENLABS_API_KEY',
      !anthropicKey && 'ANTHROPIC_API_KEY',
    ]
      .filter(Boolean)
      .join(', ');
    console.error(`[report] missing env: ${missing}`);
    return json({ error: `Server is missing: ${missing}.` }, 500);
  }

  let conversationId: unknown;
  try {
    ({ conversationId } = await request.json());
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  if (typeof conversationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(conversationId)) {
    return json({ error: 'Invalid conversationId.' }, 400);
  }

  // 1 · Fetch the conversation from ElevenLabs
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
    { headers: { 'xi-api-key': elevenKey } }
  );
  if (resp.status === 404) return json({ error: 'Conversation not found.' }, 404);
  if (!resp.ok) return json({ error: `ElevenLabs returned ${resp.status}.` }, 502);
  const conversation = await resp.json();

  // Only conversations with our own training agents can be analyzed.
  const customer = agents.find((a) => a.agent_id === conversation.agent_id);
  if (!customer) {
    return json({ error: 'Conversation does not belong to a trainer agent.' }, 403);
  }

  // ElevenLabs needs a few seconds after the call to finish processing.
  if (conversation.status !== 'done' && conversation.status !== 'failed') {
    return json({ status: 'processing' }, 202);
  }

  const turns = (conversation.transcript ?? [])
    .filter((t: { message?: string }) => t?.message)
    .map((t: { role: string; message: string }) => ({
      speaker: t.role === 'agent' ? 'customer' : 'seller',
      message: t.message,
    }));
  if (turns.length === 0) {
    return json({ error: 'No transcript was recorded for this session.' }, 422);
  }

  const vars: Record<string, string> =
    conversation.conversation_initiation_client_data?.dynamic_variables ?? {};
  const transcriptText = turns
    .map((t: { speaker: string; message: string }) =>
      `${t.speaker === 'customer' ? 'Customer' : 'Seller'}: ${t.message}`
    )
    .join('\n');

  // The 5 evaluation criteria configured on the agent, graded by ElevenLabs.
  // Passed through verbatim to the UI and given to Claude as context.
  type RawCriterion = { criteria_id?: string; result?: string; rationale?: string };
  const rawCriteria: RawCriterion[] =
    conversation.analysis?.evaluation_criteria_results_list ??
    Object.values(conversation.analysis?.evaluation_criteria_results ?? {});
  const criteria = rawCriteria
    .filter((c) => c?.criteria_id)
    .map((c) => ({
      id: c.criteria_id as string,
      label: (c.criteria_id as string)
        .replaceAll('_', ' ')
        .replace(/^./, (ch) => ch.toUpperCase()),
      result: c.result ?? 'unknown',
      rationale: c.rationale ?? '',
    }));
  const criteriaText = criteria.length
    ? criteria
        .map((c) => `- ${c.label}: ${c.result.toUpperCase()} — ${c.rationale}`)
        .join('\n')
    : '(none configured)';

  // 2 · Grade it with Claude (structured output → no parsing surprises)
  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const message = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: REPORT_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Customer type: ${customer.label} — ${customer.description}
Product: ${vars.product_name ?? 'unknown'} — ${vars.product_price ?? ''}

Reference story (Know your piece):
${vars.product_story ?? '(not provided)'}

Known customer concerns for this piece:
${vars.product_objections ?? '(not provided)'}

Official evaluation criteria scorecard for this session (graded separately; use it as context so your improvements address the failed criteria, but judge the transcript yourself):
${criteriaText}

Transcript:
${transcriptText}`,
      },
    ],
  });

  const text = message.content.find((b) => b.type === 'text')?.text ?? '';
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return json({ error: 'The analysis came back malformed. Try again.' }, 502);
  }

  return json({
    report,
    criteria,
    transcript: turns,
    customer: customer.label,
    product: { name: vars.product_name ?? '', price: vars.product_price ?? '' },
  });
};
