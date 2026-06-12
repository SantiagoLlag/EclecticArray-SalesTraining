import { Conversation } from '@elevenlabs/client';
import { playTap, startReadyMusic, stopReadyMusic } from './audio.js';

// ——— Data (rendered into the page at build time from agents.json / products.json) ———

const { agents, products } = JSON.parse(
  document.getElementById('app-data').textContent
);

// Same rule the server uses to disable cards: a real ElevenLabs id, not a placeholder.
const isConfigured = (id) =>
  typeof id === 'string' && id.length >= 10 && !/todo|placeholder|xxx|[<>]/i.test(id);

// ——— State: one linear flow, no routing ———

const state = {
  agent: null,
  product: null,
  conversation: null,
  conversationId: null, // ElevenLabs id of the last call, used to fetch the report
  lastReport: null,
  analyzing: false,
};

const $ = (id) => document.getElementById(id);

// ——— Views ———

function show(view) {
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('is-active', v.id === `view-${view}`);
  });
  // A chooser screen always re-opens with nothing selected.
  document
    .querySelectorAll(`#view-${view} [role="option"]`)
    .forEach((o) => o.setAttribute('aria-selected', 'false'));
  if (view === 'products') resetCategoryFilter();
  document.body.dataset.view = view;
  window.scrollTo(0, 0);
}

// ——— Category filter (UI-only metadata; never sent to the agent) ———

function resetCategoryFilter() {
  const chips = $('category-chips');
  if (!chips) return;
  chips
    .querySelectorAll('.chip')
    .forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.category === 'all')));
  document.querySelectorAll('#product-list [role="option"]').forEach((card) => {
    card.hidden = false;
  });
}

const categoryChips = $('category-chips');
if (categoryChips) {
  categoryChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    categoryChips
      .querySelectorAll('.chip')
      .forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    const category = chip.dataset.category;
    document.querySelectorAll('#product-list [role="option"]').forEach((card) => {
      card.hidden = category !== 'all' && card.dataset.category !== category;
    });
  });
}

// ——— Selection screens ———

function bindOptionList(listId, onPick) {
  const list = $(listId);
  if (!list) return;

  list.addEventListener('click', (e) => {
    const card = e.target.closest('[role="option"]');
    if (!card || card.disabled) return;
    list
      .querySelectorAll('[role="option"]')
      .forEach((o) => o.setAttribute('aria-selected', String(o === card)));
    onPick(card);
  });

  // Arrow keys move between cards; Enter/Space activate (they're buttons).
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const options = [...list.querySelectorAll('[role="option"]:not(:disabled)')].filter(
      (o) => !o.hidden
    );
    const i = options.indexOf(document.activeElement);
    if (i === -1) return;
    e.preventDefault();
    const next = options[(i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length];
    next.focus();
  });
}

bindOptionList('agent-list', (card) => {
  state.agent = agents[Number(card.dataset.agentIndex)];
  show('products');
});

bindOptionList('product-list', (card) => {
  state.product = products[Number(card.dataset.productIndex)];
  show('session');
  prepareSession();
});

// ——— Session ———

const STATUS = {
  ready: {
    orb: 'is-idle',
    title: 'Ready when you are',
    sub: 'Your customer is at the door. Glance over the piece, then bring them in.',
    actions: ['begin', 'home'],
  },
  unconfigured: {
    orb: 'is-idle',
    title: 'Agent not configured yet',
    sub: 'This customer hasn’t been published by the agent composer. Once agents.json has its ElevenLabs id, it works here automatically.',
    actions: ['home'],
  },
  'mic-denied': {
    orb: 'is-idle',
    title: 'Microphone needed',
    sub: 'Training is by voice. Allow microphone access in your browser settings, then try again.',
    actions: ['retry', 'home'],
  },
  connecting: {
    orb: 'is-connecting',
    title: 'Your customer is walking in…',
    sub: 'Connecting. Take a breath.',
    actions: ['end'],
  },
  listening: {
    orb: 'is-listening',
    title: 'Your turn',
    sub: 'They’re listening. Speak as you would on the floor.',
    actions: ['end'],
  },
  speaking: {
    orb: 'is-speaking',
    title: 'is speaking…', // prefixed with the customer's label
    sub: 'Listen for the objection underneath the words.',
    actions: ['end'],
  },
  ended: {
    orb: 'is-idle',
    title: 'Session ended',
    sub: 'No conversation was recorded, so there is nothing to analyze.',
    actions: ['home'],
  },
  analyzing: {
    orb: 'is-connecting',
    title: 'Reading the room…',
    sub: 'Claude is reviewing your conversation. This takes a few seconds.',
    actions: [],
  },
  'report-error': {
    orb: 'is-idle',
    title: 'Couldn’t prepare your results',
    sub: 'The session is saved — you can retry the analysis, or head back to start.',
    actions: ['retry-report', 'home'],
  },
  error: {
    orb: 'is-idle',
    title: 'Couldn’t connect',
    sub: 'Check your internet connection and try again.',
    actions: ['retry', 'home'],
  },
};

function setStatus(name) {
  const s = STATUS[name];
  const orb = $('orb');
  orb.className = `orb ${s.orb}`;
  $('status-title').textContent =
    name === 'speaking' ? `${state.agent.label} ${s.title}` : s.title;
  $('status-sub').textContent = s.sub;
  $('btn-begin').hidden = !s.actions.includes('begin');
  $('btn-end').hidden = !s.actions.includes('end');
  $('btn-retry').hidden = !s.actions.includes('retry');
  $('btn-retry-report').hidden = !s.actions.includes('retry-report');
  $('btn-home').hidden = !s.actions.includes('home');
}

function renderCrib() {
  const { agent, product } = state;
  $('session-customer').textContent = agent.label;
  $('session-product').textContent = product.name;
  $('session-price').textContent = product.price;

  const thumb = $('session-thumb');
  thumb.src = `${product.image}${product.image.includes('?') ? '&' : '?'}width=160`;
  thumb.alt = product.name;
  thumb.onerror = () => {
    thumb.onerror = null;
    thumb.src = `/products/${product.id}.png`;
  };

  const fill = (id, items) => {
    const ul = $(id);
    ul.textContent = '';
    items.forEach((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      ul.appendChild(li);
    });
  };
  fill('session-story', product.story);
  fill('session-objections', product.objections);
}

function appendTranscript(source, message) {
  if (!message) return;
  const feed = $('transcript');
  const line = document.createElement('div');
  line.className = `line ${source === 'ai' ? 'from-agent' : 'from-user'}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = source === 'ai' ? state.agent.label : 'You';
  const p = document.createElement('p');
  p.textContent = message;
  line.append(who, p);
  feed.appendChild(line);
  feed.scrollTop = feed.scrollHeight;
}

// Entering the Session screen shows the crib sheet first — the agent
// only connects when the seller taps Start Training.
function prepareSession() {
  renderCrib();
  $('transcript').textContent = '';
  const ready = isConfigured(state.agent.agent_id);
  setStatus(ready ? 'ready' : 'unconfigured');
  if (ready) startReadyMusic();
}

async function startSession() {
  const { agent, product } = state;
  stopReadyMusic();
  state.conversationId = null;
  state.lastReport = null;
  $('transcript').textContent = '';

  if (!isConfigured(agent.agent_id)) {
    setStatus('unconfigured');
    return;
  }

  setStatus('connecting');

  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setStatus('mic-denied');
    return;
  }

  try {
    state.conversation = await Conversation.startSession({
      agentId: agent.agent_id,
      connectionType: 'webrtc',

      // The contract with the agent prompts — exactly these four variables.
      dynamicVariables: {
        product_name: product.name,
        product_price: product.price,
        product_story: product.story.map((s) => `- ${s}`).join('\n'),
        product_objections: product.objections.map((s) => `- ${s}`).join('\n'),
      },

      onConnect: ({ conversationId }) => {
        state.conversationId = conversationId ?? null;
        setStatus('listening');
      },
      onDisconnect: () => {
        // Agent hung up (e.g. after deciding) — not an End-session tap.
        if (state.conversation) {
          state.conversation = null;
          analyze();
        }
      },
      onModeChange: ({ mode }) => {
        if (state.conversation) setStatus(mode === 'speaking' ? 'speaking' : 'listening');
      },
      onMessage: ({ message, source }) => appendTranscript(source, message),
      onError: (message) => {
        console.error('[trainer] conversation error:', message);
      },
    });
  } catch (err) {
    console.error('[trainer] failed to start session:', err);
    state.conversation = null;
    setStatus('error');
  }
}

async function teardown() {
  const conversation = state.conversation;
  state.conversation = null; // flag first so onDisconnect knows this was deliberate
  if (conversation) {
    try {
      await conversation.endSession();
    } catch (err) {
      console.error('[trainer] error ending session:', err);
    }
  }
}

async function endAndGoHome() {
  stopReadyMusic();
  await teardown();
  state.agent = null;
  state.product = null;
  $('transcript').textContent = '';
  show('start');
}

// ——— Results: fetch the transcript + Claude's coaching report ———

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function analyze() {
  if (!state.conversationId) {
    setStatus('ended');
    return;
  }
  if (state.analyzing) return;
  state.analyzing = true;
  setStatus('analyzing');

  try {
    // ElevenLabs takes a few seconds to process the call; 202 means "not yet".
    for (let attempt = 0; attempt < 25; attempt++) {
      if (document.body.dataset.view !== 'session') return; // user left
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: state.conversationId }),
      });
      if (res.status === 202) {
        await sleep(3000);
        continue;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      state.lastReport = data;
      renderReport(data);
      show('report');
      return;
    }
    throw new Error('Timed out waiting for the conversation to process.');
  } catch (err) {
    console.error('[trainer] analysis failed:', err);
    setStatus('report-error');
  } finally {
    state.analyzing = false;
  }
}

const OUTCOME_TITLES = {
  bought: 'Sold.',
  deferred: 'On the fence.',
  walked: 'They walked.',
  incomplete: 'Cut short.',
};

function renderReport({ report, criteria = [], transcript, customer, product }) {
  // The agent's 5 evaluation criteria, graded by ElevenLabs after the call.
  $('report-criteria-wrap').hidden = criteria.length === 0;
  const passed = criteria.filter((c) => c.result === 'success').length;
  $('report-criteria-score').textContent = criteria.length
    ? `${passed} of ${criteria.length}`
    : '';
  const criteriaList = $('report-criteria');
  criteriaList.textContent = '';
  criteria.forEach(({ label, result, rationale }) => {
    const li = document.createElement('li');
    li.className = result === 'success' ? 'told' : result === 'failure' ? 'failed' : 'missed';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = result === 'success' ? '✓' : result === 'failure' ? '✗' : '?';
    const body = document.createElement('span');
    const pointEl = document.createElement('span');
    pointEl.className = 'point';
    pointEl.textContent = label;
    body.appendChild(pointEl);
    if (rationale) {
      const noteEl = document.createElement('span');
      noteEl.className = 'note';
      noteEl.textContent = rationale;
      body.appendChild(noteEl);
    }
    li.append(mark, body);
    criteriaList.appendChild(li);
  });

  $('report-outcome').textContent = OUTCOME_TITLES[report.outcome] ?? 'Session results';
  $('report-quote').textContent = report.outcome_quote || '';
  $('report-context').textContent = [customer, product?.name, product?.price]
    .filter(Boolean)
    .join(' · ');
  $('report-summary').textContent = report.summary;

  const story = $('report-story');
  story.textContent = '';
  report.story_coverage.forEach(({ point, covered, note }) => {
    const li = document.createElement('li');
    li.className = covered ? 'told' : 'missed';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = covered ? '✓' : '—';
    const body = document.createElement('span');
    const pointEl = document.createElement('span');
    pointEl.className = 'point';
    pointEl.textContent = point;
    body.appendChild(pointEl);
    if (note) {
      const noteEl = document.createElement('span');
      noteEl.className = 'note';
      noteEl.textContent = note;
      body.appendChild(noteEl);
    }
    li.append(mark, body);
    story.appendChild(li);
  });

  const objections = $('report-objections');
  objections.textContent = '';
  if (report.objection_handling.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'The customer never pushed back — an unusually easy room.';
    objections.appendChild(li);
  }
  report.objection_handling.forEach(({ objection, rating, note }) => {
    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = `rating ${rating}`;
    chip.textContent = rating;
    const body = document.createElement('span');
    const obj = document.createElement('span');
    obj.textContent = objection;
    body.appendChild(obj);
    if (note) {
      const noteEl = document.createElement('span');
      noteEl.className = 'note';
      noteEl.textContent = note;
      body.appendChild(noteEl);
    }
    li.append(chip, body);
    objections.appendChild(li);
  });

  $('report-best-wrap').hidden = !report.best_moment;
  $('report-best').textContent = report.best_moment;

  const improvements = $('report-improvements');
  improvements.textContent = '';
  report.improvements.forEach((tip) => {
    const li = document.createElement('li');
    li.textContent = tip;
    improvements.appendChild(li);
  });

  const feed = $('report-transcript');
  feed.textContent = '';
  transcript.forEach(({ speaker, message }) => {
    const line = document.createElement('div');
    line.className = speaker === 'customer' ? 'from-agent' : 'from-user';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = speaker === 'customer' ? customer : 'You';
    const p = document.createElement('p');
    p.textContent = message;
    line.append(who, p);
    feed.appendChild(line);
  });
}

function downloadTranscript() {
  const data = state.lastReport;
  if (!data) return;
  const stamp = new Date().toISOString().slice(0, 16).replace(':', '');
  const header = `Eclectic Array — Sales Trainer\n${data.customer} · ${data.product?.name ?? ''} ${data.product?.price ?? ''}\n\n`;
  const lines = data.transcript
    .map((t) => `${t.speaker === 'customer' ? data.customer : 'Seller'}: ${t.message}`)
    .join('\n');
  const blob = new Blob([header + lines + '\n'], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `training-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ——— Wiring ———

// Every button and the accordion get the same soft tap. Capture phase so the
// sound rides the same gesture even when the handler swaps screens.
document.addEventListener(
  'click',
  (e) => {
    if (e.target.closest('button, summary')) playTap();
  },
  true
);

$('btn-start').addEventListener('click', () => show('agents'));
$('btn-begin').addEventListener('click', startSession);
$('btn-end').addEventListener('click', async () => {
  await teardown();
  analyze();
});
$('btn-home').addEventListener('click', endAndGoHome);
$('btn-retry').addEventListener('click', startSession);
$('btn-retry-report').addEventListener('click', analyze);
$('btn-report-done').addEventListener('click', endAndGoHome);
$('btn-download').addEventListener('click', downloadTranscript);

$('btn-back').addEventListener('click', () => {
  const view = document.body.dataset.view;
  if (view === 'products') show('agents');
  else if (view === 'agents') show('start');
});

// Dev-only hook so the report screen can be exercised without a live call;
// stripped from production builds.
if (import.meta.env.DEV) {
  window.__trainer = { state, show, renderReport, analyze, setStatus };
}

// Leaving the page mid-call: close the conversation cleanly.
window.addEventListener('pagehide', () => {
  stopReadyMusic(0);
  if (state.conversation) {
    const c = state.conversation;
    state.conversation = null;
    c.endSession();
  }
});
