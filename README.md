# Eclectic Array — Sales Trainer

A voice training app for boutique staff: pick a customer type, pick a product, and practice the sale against a simulated customer (an ElevenLabs agent). Three taps from start to talking. Mobile-first, built for a tablet or phone in hand on the shop floor.

## Stack

- [Astro](https://astro.build) (static output) + vanilla JS — one page, four views, no router.
- [`@elevenlabs/client`](https://www.npmjs.com/package/@elevenlabs/client) for the voice session lifecycle.
- Plain CSS, Instrument Sans / Instrument Serif via Google Fonts.

```bash
npm install
npm run dev       # local dev at localhost:4321
npm run build     # static build to dist/
```

Deploy: push to Vercel — it auto-detects Astro and serves the static build. No env vars, no server.

## Data contracts (the only things you ever edit)

Adding an agent or a product touches **zero components** — only these two files.

### `src/data/agents.json` — written by the agent composer, never by hand

The composer in the agents repo emits this file; the UI just renders whatever is in it. One entry per ElevenLabs agent:

```json
{
  "agent_id": "<elevenlabs-agent-id>",
  "label": "The Haggler",
  "description": "One or two lines telling the seller what muscle this customer trains."
}
```

If `agent_id` is missing, empty, or a placeholder (contains `TODO`, `placeholder`, `<`, `>`), the card renders disabled with "Not available yet" — the UI never breaks. When the composer publishes a new agent (e.g. Goldmine), its card appears on the next build.

When 2+ agents are configured, a **Mystery Customer** card also appears: it picks a configured agent at random and masks its identity everywhere in the UI (crib chip, status line, live transcript) until the results screen reveals it.

### `src/data/products.json` — the catalog, edited by hand

```json
{
  "id": "kebab-case-id",
  "name": "Product Name",
  "price": "$240",
  "image": "https://…shopify cdn url…",
  "description": "One-line product description.",
  "story": ["Know-your-piece bullet", "…"],
  "objections": ["Likely objection", "…"]
}
```

Images hotlink to the Shopify CDN (`?width=` resizing, lazy-loaded). If a hotlink ever fails, the card falls back to a local copy at `public/products/<id>.png` — keep one there when adding a product.

## ElevenLabs integration

The UI's entire contact surface with ElevenLabs is `agent_id` plus four dynamic variables. It never reads or writes agent configuration.

- Choosing a training type **is** choosing an `agent_id` — each specialty is its own agent; there is no `training_type` variable.
- The Session screen opens in a ready state showing the crib sheet; tapping **Start Training** requests the microphone, then calls:

```js
Conversation.startSession({
  agentId,
  connectionType: 'webrtc',
  dynamicVariables: {
    product_name,        // "Chiapas Sandals — Dark Magenta"
    product_price,       // "$240"
    product_story,       // know-your-piece bullets, newline-joined
    product_objections,  // objection bullets, newline-joined
  },
  …callbacks
})
```

- **End session** calls `endSession()` and tears down; one session = one agent + one product. To switch, end and start again.

## Session results (`/api/report`)

When a session ends (either side hangs up), the UI posts the ElevenLabs `conversationId` to `/api/report` — the project's single serverless route (deployed as a Vercel function via `@astrojs/vercel`). The endpoint:

1. Fetches the conversation from ElevenLabs (`GET /v1/convai/conversations/:id`), polling-friendly: returns `202` while ElevenLabs is still processing the call.
2. Verifies the conversation belongs to one of the agents in `agents.json` and reads back the product context from the call's dynamic variables — the client can't inject a fake rubric.
3. Reads the agent's **evaluation criteria results** (the 5 criteria configured on each agent in ElevenLabs, graded automatically per call) and passes them through verbatim — and to Claude as context.
4. Sends the transcript to Claude (`claude-opus-4-8`, structured JSON output) with a sales-coaching rubric: outcome, **ticket size** (units × price − concessions, computed from the transcript), story coverage vs Know-your-piece, objection handling, best moment, and 2-3 improvements.
5. Returns `{ report, criteria, transcript, customer, product }`, which the UI renders on the Results screen (plus a client-side "Download transcript" button).

Configuration: copy `.env.example` to `.env` locally, and set `ELEVENLABS_API_KEY` + `ANTHROPIC_API_KEY` in Vercel project settings. Keys live only server-side.
