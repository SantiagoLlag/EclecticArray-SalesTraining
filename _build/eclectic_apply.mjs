// Replace "Lori" -> "Retail Sales Customer" in one agent's live prompt and,
// optionally, set its voice. Usage:
//   KEY=<elevenlabs key> node eclectic_apply.mjs <agent_id> [voice_id]
// Reads KEY from env (never hardcode/echo). GET -> replace -> PATCH the merged
// conversation_config -> re-GET verify. Prints one JSON line.

const KEY = process.env.KEY;
const id = process.argv[2];
const voiceId = process.argv[3] || null;
const BASE = 'https://api.elevenlabs.io/v1/convai/agents/';
const out = (o) => console.log(JSON.stringify(o));

(async () => {
  if (!KEY) return out({ id, error: 'no KEY in env' });
  if (!id) return out({ id, error: 'no agent_id arg' });
  const H = { 'xi-api-key': KEY };
  const HJ = { 'xi-api-key': KEY, 'Content-Type': 'application/json' };

  const c = await (await fetch(BASE + id, { headers: H })).json();
  const name = c.name || '';
  const cc = c.conversation_config || {};
  cc.agent = cc.agent || {};
  cc.agent.prompt = cc.agent.prompt || {};
  const oldPrompt = cc.agent.prompt.prompt || '';
  const before = (oldPrompt.match(/Lori/g) || []).length;
  cc.agent.prompt.prompt = oldPrompt.replace(/Lori/g, 'Retail Sales Customer');
  cc.tts = cc.tts || {};
  if (voiceId) cc.tts.voice_id = voiceId;

  const r = await fetch(BASE + id, {
    method: 'PATCH',
    headers: HJ,
    body: JSON.stringify({ conversation_config: cc }),
  });
  const errBody = r.status >= 300 ? (await r.text()).slice(0, 400) : '';

  const v = await (await fetch(BASE + id, { headers: H })).json();
  out({
    id,
    name: v.name || name,
    patch_status: r.status,
    lori_before: before,
    lori_after: ((v.conversation_config?.agent?.prompt?.prompt || '').match(/Lori/g) || []).length,
    voice_id: v.conversation_config?.tts?.voice_id ?? null,
    err: errBody || null,
  });
})().catch((e) => out({ id, error: e.message }));
