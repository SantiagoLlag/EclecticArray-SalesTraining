import { Conversation } from '@elevenlabs/client';
import { playTap, startReadyMusic, stopReadyMusic } from './audio.js';

// ——— Data (rendered into the page at build time from agents.json / products.json) ———

const { agents, products, quiz = [], stores = [], drills = [] } = JSON.parse(
  document.getElementById('app-data').textContent
);
const storeById = Object.fromEntries(stores.map((s) => [s.id, s]));

// Same rule the server uses to disable cards: a real ElevenLabs id, not a placeholder.
const isConfigured = (id) =>
  typeof id === 'string' && id.length >= 10 && !/todo|placeholder|xxx|[<>]/i.test(id);

// ——— State: one linear flow, no routing ———

const state = {
  agent: null,
  product: null,
  mystery: false, // random pick, identity masked until the results screen
  conversation: null,
  conversationId: null, // ElevenLabs id of the last call, used to fetch the report
  lastReport: null,
  analyzing: false,
  seller: null, // { id, name } — who's training on this device (kiosk session cookie)
  roster: null, // cached /api/roster response; null until first fetch
  lastActiveAt: Date.now(),
  store: null, // the store whose floor we're practicing (device-level; localStorage)
  categoryFilter: 'all', // product-picker category chip, composed with the store filter
  sessionType: null, // 'drill' while a drill runs, else null → discriminates start / end / status
  drill: null, // selected drills.json object
  drillSeed: null, // current makeDrillSeed() value
  drillVariant: null, // variant name chosen by makeDrillSeed — sent to the agent as drill_variant
  lastVerdict: null, // last {result,fix,quote}
  drillVerdicting: false, // reentrancy guard for runDrillVerdict()
  drillDeadlineAt: null, // Date.now()+FORCE_MS, for the 2:30 hard stop
  drillTick: null, // setInterval id (countdown)
  drillForce: null, // setTimeout id (force-end)
  progressCache: null, // last /api/my-progress json, cached to feed Drill-of-day weakest-dim pick
};

// What the seller sees while the session runs — the real agent stays hidden in
// mystery mode until the report reveals it.
const customerLabel = () => (state.mystery ? 'Mystery customer' : state.agent.label);

const $ = (id) => document.getElementById(id);

// ——— Views ———

function show(view) {
  state.lastActiveAt = Date.now(); // feeds the kiosk auto-lock
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('is-active', v.id === `view-${view}`);
  });
  // A chooser screen always re-opens with nothing selected.
  document
    .querySelectorAll(`#view-${view} [role="option"]`)
    .forEach((o) => o.setAttribute('aria-selected', 'false'));
  if (view === 'products') resetCategoryFilter();
  // The dashboard always re-opens with both tracks equal (no track expanded yet).
  if (view === 'agents') {
    const sw = $('track-switch');
    if (sw) {
      sw.classList.remove('has-selection');
      sw.querySelectorAll('.track-panel').forEach((p) => p.classList.remove('is-active'));
    }
    stampDrillOfDay();
  }
  document.body.dataset.view = view;
  window.scrollTo(0, 0);
}

// ——— Category filter (UI-only metadata; never sent to the agent) ———

// A product card shows only when it passes BOTH the category chip and the current store.
// A card with no store list is carried everywhere (honest default until the catalog is
// curated), so filtering is a no-op until pieces get a `stores` field in products.json.
function updateProductVisibility() {
  const cat = state.categoryFilter || 'all';
  document.querySelectorAll('#product-list [role="option"]').forEach((card) => {
    const inCategory = cat === 'all' || card.dataset.category === cat;
    const cardStores = (card.dataset.stores || '').split(',').filter(Boolean);
    const inStore = !state.store || cardStores.length === 0 || cardStores.includes(state.store);
    card.hidden = !(inCategory && inStore);
  });
}

function resetCategoryFilter() {
  state.categoryFilter = 'all';
  const chips = $('category-chips');
  if (chips) {
    chips
      .querySelectorAll('.chip')
      .forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.category === 'all')));
  }
  updateProductVisibility();
}

const categoryChips = $('category-chips');
if (categoryChips) {
  categoryChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    categoryChips
      .querySelectorAll('.chip')
      .forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    state.categoryFilter = chip.dataset.category;
    updateProductVisibility();
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

function pickAgent(card) {
  if ('quiz' in card.dataset) {
    // The Inventory Quiz is a screen-based drill, not a voice agent.
    show('quiz-setup');
    return;
  }
  if ('mystery' in card.dataset) {
    // Mystery pools only over the close-the-sale personas (the agents with no mode) — The
    // Browser or the Mentor would be an instant giveaway. Same rule as the dashboard gate.
    const pool = agents.filter((a) => isConfigured(a.agent_id) && !a.mode);
    if (pool.length === 0) return; // the dashboard gate should prevent this; never crash on it
    state.agent = pool[Math.floor(Math.random() * pool.length)];
    state.mystery = true;
  } else {
    state.agent = agents[Number(card.dataset.agentIndex)];
    state.mystery = false;
  }
  if (state.agent && state.agent.mode === 'inventory') {
    // The Browser roams the whole floor — there is no single product to pick.
    state.product = null;
    show('session');
    prepareSession();
  } else {
    // The product step reads differently when the roles flip: the Mentor sells to YOU.
    $('products-sub').textContent =
      state.agent && state.agent.mode === 'mentor'
        ? 'Pick the piece he’ll sell to you. You’ll have its true story on hand to test him.'
        : 'This is the piece on the counter. Know it before they ask.';
    show('products');
  }
}
// The dashboard has two tracks; both pick an agent the same way.
bindOptionList('agent-list', pickAgent);
bindOptionList('inventory-list', pickAgent);

// The drills rail is a horizontal strip of 2-minute reps, not a persona list.
$('drill-rail')?.addEventListener('click', (e) => {
  const c = e.target.closest('[data-drill-index]');
  if (!c || c.disabled) return;
  onPickDrill(drills[Number(c.dataset.drillIndex)]);
});

function onPickDrill(drill) {
  if (!drill || !isConfigured(drill.agent_id)) return; // coming-soon cards are .disabled; belt-and-suspenders
  openDrillIntro(drill);
}

function openDrillIntro(drill) {
  state.drill = drill;
  $('drill-intro-icon').textContent = drill.icon;
  $('drill-intro-title').textContent = drill.label;
  $('drill-intro-trains').textContent = drill.trains;
  $('drill-intro-pass').textContent = drill.pass_line;
  const ov = $('drill-intro');
  ov.hidden = false;
  document.body.style.overflow = 'hidden';
  $('drill-intro-go').focus();
}

function closeDrillIntro() {
  $('drill-intro').hidden = true;
  document.body.style.overflow = '';
}

// Two side-by-side track panels: clicking one expands it (revealing its options) and shrinks the other.
function selectTrack(name) {
  const sw = $('track-switch');
  if (!sw) return;
  sw.classList.add('has-selection');
  sw.querySelectorAll('.track-panel').forEach((p) => {
    p.classList.toggle('is-active', p.dataset.track === name);
  });
}
document.querySelectorAll('[data-select-track]').forEach((btn) => {
  btn.addEventListener('click', () => selectTrack(btn.dataset.selectTrack));
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

// Mentor de Ventas flips the roles (the agent sells, the trainee is the client), so the
// coaching copy flips with it; statuses not listed here read the same in both roles.
const MENTOR_STATUS = {
  ready: { sub: 'The seller is on the floor. Walk in as the client — browse, push on price, and make him earn it.' },
  connecting: { title: 'The seller is coming over…' },
  listening: { sub: 'He’s listening. Push back the way a real customer would.' },
  speaking: { sub: 'Watch the moves: the welcome, the true story, how he holds the price.' },
};

// A drill is one tight rep, not a full encounter — the copy narrows to that.
const DRILL_STATUS = {
  ready: { title: 'Piece is up.', sub: 'Two minutes. One rep. Begin when ready.' },
  listening: { title: 'Your floor.', sub: 'Work the rep.' },
  analyzing: { title: 'Grading the rep…', sub: 'One moment.' },
};

function setStatus(name) {
  const s =
    state.agent?.mode === 'mentor'
      ? { ...STATUS[name], ...MENTOR_STATUS[name] }
      : state.agent?.mode === 'drill'
      ? { ...STATUS[name], ...(DRILL_STATUS[name] || {}) }
      : STATUS[name];
  const orb = $('orb');
  orb.className = `orb ${s.orb}`;
  $('status-title').textContent =
    name === 'speaking'
      ? `${state.mystery ? 'Your customer' : state.agent.label} ${s.title}`
      : s.title;
  $('status-sub').textContent = s.sub;
  $('btn-begin').hidden = !s.actions.includes('begin');
  $('btn-end').hidden = !s.actions.includes('end');
  $('btn-retry').hidden = !s.actions.includes('retry');
  $('btn-retry-report').hidden = !s.actions.includes('retry-report');
  $('btn-home').hidden = !s.actions.includes('home');
}

const fillList = (id, items) => {
  const ul = $(id);
  ul.textContent = '';
  (items || []).forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    ul.appendChild(li);
  });
};

function setPieceThumb(product) {
  const thumb = $('session-thumb');
  thumb.classList.remove('is-empty');
  thumb.src = `${product.image}${product.image.includes('?') ? '&' : '?'}width=160`;
  thumb.alt = product.name;
  thumb.onerror = () => {
    thumb.onerror = null;
    thumb.src = `/products/${product.id}.png`;
  };
}

function renderCrib() {
  $('session-customer').textContent = customerLabel();
  const crib = document.querySelector('.crib');
  // The mentor branch retitles these shared captions, so restore the defaults up front —
  // whichever mode renders next starts from the static text.
  document.querySelector('#session-story-wrap summary').textContent = 'Know your piece';
  document.querySelector('#session-objections-wrap summary').textContent = 'Objections to expect';

  if (state.agent?.mode === 'inventory') {
    // The Browser: an empty 'current piece' panel that fills live as she points (focus_product).
    crib.classList.add('crib--inventory');
    state.roamTrail = [];
    $('session-roam').hidden = false;
    $('session-roam').textContent = 'Roaming the whole floor…';
    $('session-product').textContent = 'The whole floor';
    $('session-price').textContent = '';
    const thumb = $('session-thumb');
    thumb.removeAttribute('src');
    thumb.alt = '';
    thumb.classList.add('is-empty');
    fillList('session-story', ['They’re browsing — each piece appears here as they point at it. Tell its story.']);
    fillList('session-objections', []);
    $('session-story-wrap').open = true; // hint visible until the first piece
    $('session-objections-wrap').open = false;
    return;
  }

  // Single-product trainers and the Mentor share one crib. The Mentor flips the framing:
  // the trainee is the CLIENT and gets the TRUE story to test the master against.
  const mentor = state.agent?.mode === 'mentor';
  const { product } = state;
  crib.classList.remove('crib--inventory');
  $('session-roam').hidden = true;
  if (mentor) $('session-customer').textContent = 'You are the client';
  $('session-product').textContent = product.name;
  $('session-price').textContent = product.price;
  setPieceThumb(product);
  fillList('session-story', product.story);
  fillList('session-objections', product.objections);
  if (mentor) {
    document.querySelector('#session-story-wrap summary').textContent = 'The true story — test him against it';
    document.querySelector('#session-objections-wrap summary').textContent = 'Push on these to test him';
  }
  $('session-story-wrap').open = !mentor;
  $('session-objections-wrap').open = false;
}

// A drill shows the same piece crib, but the customer label is the drill and the reference
// details fold away — rehearsal must not spoon-feed the answer. The Story Sprint is the one
// exception: its story stays open to read while telling (recall is the quiz's job).
function renderDrillCrib() {
  const { product, drill } = state;
  $('session-customer').textContent = drill.label;
  const crib = document.querySelector('.crib');
  crib.classList.remove('crib--inventory');
  $('session-roam').hidden = true;
  document.querySelector('#session-story-wrap summary').textContent = 'Know your piece';
  document.querySelector('#session-objections-wrap summary').textContent = 'Objections to expect';
  if (product === null) {
    // Improv: there is no real piece. Hide the thumb + name/price line and show a cue instead;
    // both reference wraps collapse (nothing real to reveal). photo:'none' matches no CSS rule.
    $('session-product').textContent = 'An invented piece — they’ll describe it. Improvise.';
    $('session-price').textContent = '';
    const thumb = $('session-thumb');
    thumb.removeAttribute('src');
    thumb.alt = '';
    thumb.classList.add('is-empty');
    fillList('session-story', []);
    fillList('session-objections', []);
    $('session-story-wrap').open = false;
    $('session-objections-wrap').open = false;
    return;
  }
  $('session-product').textContent = product.name;
  $('session-price').textContent = product.price;
  setPieceThumb(product);
  fillList('session-story', product.story);
  fillList('session-objections', product.objections);
  const isStory = drill.id === 'story';
  $('session-story-wrap').open = isStory;
  $('session-objections-wrap').open = false;
}

// Driven live by the agent's focus_product client tool: show the piece she's now on.
function showCurrentPiece(productId) {
  const product = products.find((p) => p.id === productId);
  if (!product) return;
  $('session-product').textContent = product.name;
  $('session-price').textContent = product.price;
  setPieceThumb(product);
  fillList('session-story', product.story);
  fillList('session-objections', product.objections);
  // Details stay COLLAPSED by default — the seller improvises, and can expand to peek if stuck.
  $('session-story-wrap').open = false;
  $('session-objections-wrap').open = false;
  state.roamTrail = state.roamTrail || [];
  if (state.roamTrail[state.roamTrail.length - 1] !== product.name) {
    state.roamTrail.push(product.name);
    $('session-roam').textContent = 'Roamed: ' + state.roamTrail.join('  →  ');
  }
}

function appendTranscript(source, message) {
  if (!message) return;
  const feed = $('transcript');
  const line = document.createElement('div');
  line.className = `line ${source === 'ai' ? 'from-agent' : 'from-user'}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = source === 'ai' ? (state.mystery ? 'Customer' : state.agent.label) : 'You';
  const p = document.createElement('p');
  p.textContent = message;
  line.append(who, p);
  feed.appendChild(line);
  feed.scrollTop = feed.scrollHeight;
}

// Entering the Session screen shows the crib sheet first — the agent
// only connects when the seller taps Start Training.
function prepareSession() {
  state.sessionType = null;
  state.drill = null;
  renderCrib();
  $('transcript').textContent = '';
  const ready = isConfigured(state.agent.agent_id);
  setStatus(ready ? 'ready' : 'unconfigured');
  if (ready) startReadyMusic();
}

// Fresh real-entropy token each session so the single-product customers vary their encounter
// (opening, which concerns they lead with, order, angle, mood) session-to-session.
function makeSessionSeed() {
  const b = crypto.getRandomValues(new Uint32Array(2));
  return (b[0] >>> 0).toString(36) + (b[1] >>> 0).toString(36);
}

// Only unlocked pieces are in play — locked ones stay visible in the picker but never
// reach a session, a drill, the quiz, or The Browser's roam.
const unlockedProducts = () => products.filter((p) => !p.locked);

// Fresh real-entropy seed each session so The Browser's roam varies session-to-session.
function makeRoamSeed() {
  const ids = unlockedProducts().map((p) => p.id);
  const buf = new Uint32Array(8);
  crypto.getRandomValues(buf);
  const picks = [];
  const used = new Set();
  for (let i = 0; i < buf.length && picks.length < 5; i++) {
    const idx = buf[i] % ids.length;
    if (!used.has(idx)) {
      used.add(idx);
      picks.push(ids[idx]);
    }
  }
  return picks.join(', ');
}

// A drill remembers the last variant it ran per drill so a Reintentar never re-throws the
// same opening. Every access try/catch-wrapped, degrades silently in private mode.
const DRILL_SEEN_KEY = 'eclectic_drill_variant';
function drillLastVariant(id) {
  try {
    return (JSON.parse(localStorage.getItem(DRILL_SEEN_KEY)) || {})[id];
  } catch {
    return undefined;
  }
}
function drillMarkVariant(id, idx) {
  try {
    const m = JSON.parse(localStorage.getItem(DRILL_SEEN_KEY)) || {};
    m[id] = idx;
    localStorage.setItem(DRILL_SEEN_KEY, JSON.stringify(m));
  } catch {
    /* storage off — the "never repeat last" guard degrades to pure random */
  }
}

// The variant tables live here for anti-repeat bookkeeping; the semantics live in the agent
// profiles. The NAMES are the contract — each must match a variant line in its drill's
// profile exactly (the chosen name travels to the agent as the drill_variant dynamic
// variable; the agent never parses the seed).
const DRILL_VARIANTS = {
  objection: ['price-vs-alt', 'authenticity', 'durability-care', 'suitability', 'need-to-think', 'online-cheaper', 'color-style', 'size-fit', 'spotted-imperfection', 'quality-doubt'],
  price: ['flat-20', 'cash-now', 'round-down', 'only-if-bundle', 'competitor-quote', 'walk-threat'],
  story: ['who-made', 'technique', 'materials', 'time-effort', 'meaning', 'why-this-one'],
  close: ['price-hesitation', 'ask-partner', 'not-today', 'will-i-use', 'look-around', 'gift-doubt'],
  improv: ['textile-weave', 'clay-ceramic', 'jewelry-stone', 'wood-carving', 'glass-mirror', 'leather-fiber'],
};
function makeDrillSeed(drill) {
  const table = DRILL_VARIANTS[drill.id] || [];
  const n = Math.max(drill.variants || table.length || 6, 1);
  const buf = crypto.getRandomValues(new Uint32Array(3));
  let idx = buf[0] % n;
  const last = drillLastVariant(drill.id);
  if (n > 1 && idx === last) idx = (idx + 1) % n; // never repeat the immediately-previous variant
  drillMarkVariant(drill.id, idx);
  state.drillVariant = table[idx] || ''; // sent as drill_variant — the agent reads this, never the seed
  const entropy = (buf[1] >>> 0).toString(36) + (buf[2] >>> 0).toString(36);
  return idx.toString(36) + entropy; // first char = variant index (base36), rest = per-run entropy
}

// Same store semantics as the product picker / quiz — but inlined, since there is no
// module-level inStore helper.
function drawDrillProduct() {
  const fits = (p) =>
    !state.store || !Array.isArray(p.stores) || p.stores.length === 0 || p.stores.includes(state.store);
  const unlocked = unlockedProducts();
  const pool = unlocked.filter(fits);
  const src = pool.length ? pool : unlocked.length ? unlocked : products;
  const b = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
  return src[b % src.length];
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

  const inventory = agent.mode === 'inventory';

  // A drill sends the same four product variables as a single-product session, but with
  // drill_seed (NEVER session_seed); The Browser roams with a fresh entropy seed; everyone
  // else is a single/mentor product session.
  let dynamicVariables;
  if (agent.mode === 'drill') {
    // Improv (no_product) has no piece on the counter: seed + variant only, never touch product.
    dynamicVariables = state.drill?.no_product
      ? { drill_seed: state.drillSeed, drill_variant: state.drillVariant || '' }
      : {
          product_name: product.name,
          product_price: product.price,
          product_story: product.story.map((s) => `- ${s}`).join('\n'),
          product_objections: product.objections.map((s) => `- ${s}`).join('\n'),
          drill_seed: state.drillSeed,
          drill_variant: state.drillVariant || '',
        };
  } else if (inventory) {
    dynamicVariables = { roam_seed: makeRoamSeed() };
  } else {
    dynamicVariables = {
      product_name: product.name,
      product_price: product.price,
      product_story: product.story.map((s) => `- ${s}`).join('\n'),
      product_objections: product.objections.map((s) => `- ${s}`).join('\n'),
      session_seed: makeSessionSeed(),
    };
  }

  try {
    state.conversation = await Conversation.startSession({
      agentId: agent.agent_id,
      connectionType: 'webrtc',

      dynamicVariables,

      // The Browser drives the on-screen reference by calling focus_product on each pivot.
      // Harmless for the other agents (they never call it).
      clientTools: {
        focus_product: ({ product_id }) => {
          showCurrentPiece(product_id);
        },
      },

      onConnect: ({ conversationId }) => {
        state.conversationId = conversationId ?? null;
        setStatus('listening');
        if (state.sessionType === 'drill') startDrillCountdown();
      },
      onDisconnect: () => {
        // Agent hung up (e.g. after deciding) — not an End-session tap.
        if (state.conversation) {
          state.conversation = null;
          if (state.sessionType === 'drill') {
            clearDrillTimers();
            runDrillVerdict();
          } else {
            analyze();
          }
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
  clearDrillTimers(); // safe for persona sessions (no-op when no drill timers are live)
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
  state.mystery = false;
  clearDrillTimers();
  state.sessionType = null;
  state.drill = null;
  $('transcript').textContent = '';
  show('start');
}

// ——— Drills: one tight 2-minute rep, graded by /api/drill-verdict ———

// Begin is chained inside the intro-CTA click so the user gesture carries into getUserMedia +
// WebRTC + audio (iPad Safari requires it).
function beginDrill() {
  const drill = state.drill;
  closeDrillIntro();
  state.sessionType = 'drill';
  state.mystery = false;
  // Improv runs without a real product: no draw, null piece, seed-only dynamic variables.
  state.product = drill.no_product ? null : drawDrillProduct();
  state.agent = { agent_id: drill.agent_id, label: drill.label, mode: 'drill' };
  state.drillSeed = makeDrillSeed(drill);
  show('session');
  const grid = $('view-session').querySelector('.session-grid');
  grid.dataset.drill = drill.id;
  grid.dataset.drillPhoto = drill.photo; // CSS hooks (hero photo, etc.)
  renderDrillCrib();
  startSession();
}

// The countdown recomputes remaining time from wall-clock deltas (not a decrement) so a
// throttled/backgrounded iPad tab shows a stale number then snaps correct on refocus; the
// 2:30 hard stop is enforced both by the in-interval check and a belt-and-suspenders timeout.
const DRILL_VISIBLE_MS = 120000; // 2:00 shown
const DRILL_FORCE_MS = 150000; // 2:30 hard stop
function startDrillCountdown() {
  const start = Date.now();
  state.drillDeadlineAt = start + DRILL_FORCE_MS;
  const el = $('drill-countdown');
  el.hidden = false;
  const paint = () => {
    const remain = Math.max(0, DRILL_VISIBLE_MS - (Date.now() - start));
    const s = Math.ceil(remain / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    el.classList.toggle('is-over', remain === 0);
    if (Date.now() >= state.drillDeadlineAt && state.conversation) forceEndDrill();
  };
  paint();
  state.drillTick = setInterval(paint, 500);
  state.drillForce = setTimeout(() => {
    if (state.conversation) forceEndDrill();
  }, DRILL_FORCE_MS);
}
function clearDrillTimers() {
  clearInterval(state.drillTick);
  clearTimeout(state.drillForce);
  state.drillTick = state.drillForce = null;
  const el = $('drill-countdown');
  if (el) {
    el.hidden = true;
    el.classList.remove('is-over');
  }
}
async function forceEndDrill() {
  clearDrillTimers();
  await teardown();
  runDrillVerdict();
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
        body: JSON.stringify({
          conversationId: state.conversationId,
          mystery: state.mystery,
          store: state.store,
        }),
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

// The drill's own verdict path: a lean /api/drill-verdict (not /api/report), same 202 polling.
async function runDrillVerdict() {
  if (!state.conversationId) {
    setStatus('ended');
    return;
  }
  if (state.drillVerdicting) return;
  state.drillVerdicting = true;
  setStatus('analyzing');
  try {
    for (let i = 0; i < 25; i++) {
      if (document.body.dataset.view !== 'session') return; // user bailed
      const res = await fetch('/api/drill-verdict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: state.conversationId,
          drillId: state.drill.id,
          store: state.store,
        }),
      });
      if (res.status === 202) {
        await sleep(3000);
        continue;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      state.lastVerdict = data;
      renderDrillVerdict(data);
      show('drill-verdict');
      return;
    }
    throw new Error('timeout');
  } catch (err) {
    console.error('[drill-verdict]', err);
    setStatus('report-error'); // reuse report-error status + its retry button (rebound below)
  } finally {
    state.drillVerdicting = false;
  }
}

function renderDrillVerdict({ result, fix, quote, missing = [], verify = [] }) {
  const pass = result === 'pass';
  $('drill-verdict-badge').className = `rating ${pass ? 'strong' : 'weak'}`;
  $('drill-verdict-badge').textContent = pass ? 'Pass' : 'Retry';
  $('drill-verdict-title').textContent = pass ? 'Clean rep.' : 'Run it again.';
  $('drill-verdict-fix').textContent = fix || '';
  const q = $('drill-verdict-quote');
  q.textContent = quote || '';
  q.hidden = !quote;
  $('drill-verdict-sub').textContent = state.drill.pass_line;
  // Coaching lists: documented story she left unused, and claims to verify (never a penalty —
  // the sheet is a reference, not the complete truth). Cards hide when empty.
  const fillList = (cardId, listId, items, mark, cls) => {
    const card = $(cardId);
    if (!card) return;
    const list = $(listId);
    list.textContent = '';
    (items || []).forEach((point) => list.appendChild(markedListItem(cls, mark, point, '')));
    card.hidden = !(items && items.length);
  };
  fillList('drill-verdict-missing-card', 'drill-verdict-missing', missing, '—', 'missed');
  fillList('drill-verdict-verify-card', 'drill-verdict-verify', verify, '?', 'told');
}

// Same piece (rehearsal convergence), fresh seed (a different variant is guaranteed). No intro.
function retryDrill() {
  state.drillSeed = makeDrillSeed(state.drill);
  show('session');
  const grid = $('view-session').querySelector('.session-grid');
  grid.dataset.drill = state.drill.id;
  grid.dataset.drillPhoto = state.drill.photo;
  renderDrillCrib();
  startSession();
}

const OUTCOME_TITLES = {
  bought: 'Sold.',
  deferred: 'On the fence.',
  walked: 'They walked.',
  incomplete: 'Cut short.',
  wandered_well: 'Wandered well.',
  went_flat: 'Went flat.',
  froze: 'Froze up.',
};

const MENTOR_OUTCOME_TITLES = {
  bought: 'He closed it.',
  deferred: 'You held out.',
  walked: 'You walked.',
  incomplete: 'Cut short.',
};

// One source for the outcome headline; the on-screen report uses it as-is and the
// downloadable text strips the trailing period, so the two can't drift apart.
function outcomeTitle(mode, outcome) {
  const titles = mode === 'mentor' ? MENTOR_OUTCOME_TITLES : OUTCOME_TITLES;
  return titles[outcome] ?? (mode === 'mentor' ? 'Masterclass' : 'Session results');
}

// One builder for every mark/point/note row in the report cards (criteria, master moves,
// pieces, story coverage) so the markup can't drift between them.
function markedListItem(cls, mark, point, note) {
  const li = document.createElement('li');
  li.className = cls;
  const markEl = document.createElement('span');
  markEl.className = 'mark';
  markEl.textContent = mark;
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
  li.append(markEl, body);
  return li;
}

// The human side's transcript label per mode (the agent side always shows the agent's label).
function humanSideLabel(mode) {
  return mode === 'mentor' ? 'You (client)' : 'Seller';
}

function renderReport({ report, criteria = [], transcript, customer, product, mode }) {
  const inventory = mode === 'inventory';
  const mentor = mode === 'mentor';
  // The Browser repurposes two cards (pieces + improv); the Mentor repurposes them as a
  // masterclass breakdown (the master's moves + how he handled your pushback).
  $('report-story-title').textContent = mentor ? 'The master’s moves' : inventory ? 'Pieces she asked about' : 'Know your piece';
  $('report-objections-title').textContent = mentor ? 'How he handled your objections' : inventory ? 'Improvisation & eloquence' : 'Objections';
  const improvTitle = document.getElementById('report-improvements-title');
  if (improvTitle) improvTitle.textContent = mentor ? 'What to copy from him' : 'Next time';

  // The agent's evaluation criteria, graded by ElevenLabs after the call.
  $('report-criteria-wrap').hidden = criteria.length === 0;
  const passed = criteria.filter((c) => c.result === 'success').length;
  $('report-criteria-score').textContent = criteria.length
    ? `${passed} of ${criteria.length}`
    : '';
  const criteriaList = $('report-criteria');
  criteriaList.textContent = '';
  criteria.forEach(({ label, result, rationale }) => {
    criteriaList.appendChild(
      markedListItem(
        result === 'success' ? 'told' : result === 'failure' ? 'failed' : 'missed',
        result === 'success' ? '✓' : result === 'failure' ? '✗' : '?',
        label,
        rationale
      )
    );
  });

  $('report-outcome').textContent = outcomeTitle(mode, report.outcome);
  $('report-quote').textContent = report.outcome_quote || '';
  // The mystery is over: the report names who walked in.
  $('report-context').textContent = [
    state.mystery ? `Mystery revealed: ${customer}` : customer,
    product?.name,
    product?.price,
  ]
    .filter(Boolean)
    .join(' · ');

  const ticket = $('report-ticket');
  if (report.ticket?.amount) {
    ticket.hidden = false;
    $('report-ticket-amount').textContent = report.ticket.amount;
    $('report-ticket-note').textContent = report.ticket.note || '';
  } else {
    ticket.hidden = true;
  }

  $('report-summary').textContent =
    (inventory && report.disqualifier_triggered
      ? '⚠ Invented a product fact — that disqualifies story accuracy. '
      : mentor && report.fabrication?.triggered
      ? `⚠ He stated something the true story contradicts${report.fabrication.note ? ` (“${report.fabrication.note}”)` : ''} — don’t copy that one. `
      : '') + report.summary;

  const story = $('report-story');
  story.textContent = '';
  if (mentor) {
    // The masterclass: each move the master made, with the line and why it worked.
    (report.techniques || []).forEach(({ move, quote, why }) => {
      story.appendChild(
        markedListItem('told', '★', move, (quote ? '“' + quote + '” — ' : '') + (why || ''))
      );
    });
  } else if (inventory) {
    // Per-piece story accuracy across the pieces she actually asked about.
    const ACC = {
      strong: { cls: 'told', mark: '✓' },
      mixed: { cls: 'missed', mark: '~' },
      wrong: { cls: 'failed', mark: '✗' },
      not_probed: { cls: 'missed', mark: '—' },
    };
    (report.pieces_touched || []).forEach(({ piece, accuracy, note }) => {
      const a = ACC[accuracy] || ACC.not_probed;
      story.appendChild(markedListItem(a.cls, a.mark, piece, note));
    });
  } else {
    report.story_coverage.forEach(({ point, covered, note }) => {
      story.appendChild(markedListItem(covered ? 'told' : 'missed', covered ? '✓' : '—', point, note));
    });
  }

  const objections = $('report-objections');
  objections.textContent = '';
  // Inventory: the four improv dimensions. Single: the objections she raised.
  const items = inventory
    ? (report.improv_scorecard || []).map(({ dimension, rating, note }) => ({ label: dimension, rating, note }))
    : (report.objection_handling || []).map(({ objection, rating, note }) => ({ label: objection, rating, note }));
  if (!inventory && items.length === 0) {
    const li = document.createElement('li');
    li.textContent = mentor
      ? 'You never really pushed back — next time make him earn it.'
      : 'The customer never pushed back — an unusually easy room.';
    objections.appendChild(li);
  }
  items.forEach(({ label, rating, note }) => {
    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = `rating ${rating}`;
    chip.textContent = rating;
    const body = document.createElement('span');
    const obj = document.createElement('span');
    obj.textContent = label;
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
  ((mentor ? report.emulate : report.improvements) || []).forEach((tip) => {
    const li = document.createElement('li');
    li.textContent = tip;
    improvements.appendChild(li);
  });

  // Claims beyond the documented story (single-customer sessions only): shown to verify,
  // never as errors — the sheet is a reference, not the complete truth.
  const verifyCard = $('report-verify-card');
  if (verifyCard) {
    const claims = (!mentor && !inventory && Array.isArray(report.verify_claims)) ? report.verify_claims : [];
    const list = $('report-verify');
    list.textContent = '';
    claims.forEach((c) => list.appendChild(markedListItem('told', '?', c, '')));
    verifyCard.hidden = claims.length === 0;
  }

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
    .map((t) => `${t.speaker === 'customer' ? data.customer : humanSideLabel(data.mode)}: ${t.message}`)
    .join('\n');
  const blob = new Blob([header + lines + '\n'], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `training-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Build the full coaching report as readable text (analysis + transcript).
// Split from downloadAnalysis so it can be unit-checked without a real download.
function buildAnalysisText(data) {
  const { report = {}, criteria = [], transcript = [], customer = '', product = {}, mode } = data || {};
  const inventory = mode === 'inventory';
  const mentor = mode === 'mentor';
  const rule = '='.repeat(56);
  const outcome = outcomeTitle(mode, report.outcome).replace(/\.$/, '');
  const L = [];
  L.push('ECLECTIC ARRAY — SALES TRAINER · COACHING REPORT');
  L.push(`${customer}${product?.name ? '  ·  ' + product.name : ''}${product?.price ? '  ·  ' + product.price : ''}`);
  L.push(`Generated ${new Date().toLocaleString()}`);
  L.push(rule, '');

  L.push(`OUTCOME — ${outcome}`);
  if (report.outcome_quote) L.push(`  "${report.outcome_quote}"`);
  if (report.ticket?.amount)
    L.push(`  Ticket: ${report.ticket.amount}${report.ticket.note ? '  (' + report.ticket.note + ')' : ''}`);
  L.push('');

  if (report.summary) L.push('SUMMARY', '  ' + report.summary, '');

  if (criteria.length) {
    const passed = criteria.filter((c) => c.result === 'success').length;
    L.push(`EVALUATION CRITERIA — ${passed} of ${criteria.length} passed`);
    criteria.forEach((c) => {
      const m = c.result === 'success' ? '[PASS]' : c.result === 'failure' ? '[FAIL]' : '[ ?? ]';
      L.push(`  ${m}  ${c.label}`);
      if (c.rationale) L.push(`         ${c.rationale}`);
    });
    L.push('');
  }

  if (mentor) {
    if (report.fabrication?.triggered)
      L.push(
        `!! HE STATED A FACT THE TRUE STORY CONTRADICTS — do not copy it${report.fabrication.note ? `: "${report.fabrication.note}"` : ''}`,
        ''
      );
    if (report.techniques?.length) {
      L.push('THE MASTER’S MOVES');
      report.techniques.forEach((t) =>
        L.push(`  • ${t.move}${t.quote ? '  — “' + t.quote + '”' : ''}${t.why ? '  (' + t.why + ')' : ''}`)
      );
      L.push('');
    }
    L.push('HOW HE HANDLED YOUR OBJECTIONS');
    if (!report.objection_handling?.length) L.push('  (you never really pushed back)');
    (report.objection_handling || []).forEach((o) =>
      L.push(`  [${String(o.rating || '').toUpperCase()}]  ${o.objection}${o.note ? '  — ' + o.note : ''}`)
    );
    L.push('');
  } else if (inventory) {
    if (report.disqualifier_triggered) L.push('!! INVENTED A PRODUCT FACT — accuracy disqualified', '');
    if (report.pieces_touched?.length) {
      L.push('PIECES SHE ASKED ABOUT — story accuracy');
      report.pieces_touched.forEach((p) =>
        L.push(`  [${String(p.accuracy || '').toUpperCase()}]  ${p.piece}${p.note ? '  — ' + p.note : ''}`)
      );
      L.push('');
    }
    L.push('IMPROVISATION & ELOQUENCE');
    (report.improv_scorecard || []).forEach((d) =>
      L.push(`  [${String(d.rating || '').toUpperCase()}]  ${d.dimension}${d.note ? '  — ' + d.note : ''}`)
    );
    L.push('');
  } else {
    if (report.story_coverage?.length) {
      L.push('KNOW YOUR PIECE — story coverage');
      report.story_coverage.forEach((s) =>
        L.push(`  [${s.covered ? 'x' : ' '}]  ${s.point}${s.note ? '  — ' + s.note : ''}`)
      );
      L.push('');
    }

    L.push('OBJECTION HANDLING');
    if (!report.objection_handling?.length) L.push('  (the customer never really pushed back)');
    (report.objection_handling || []).forEach((o) =>
      L.push(`  [${String(o.rating || '').toUpperCase()}]  ${o.objection}${o.note ? '  — ' + o.note : ''}`)
    );
    L.push('');
  }

  if (report.best_moment) L.push('BEST MOMENT', `  "${report.best_moment}"`, '');

  const tips = mentor ? report.emulate : report.improvements;
  if (tips?.length) {
    L.push(mentor ? 'WHAT TO COPY FROM HIM' : 'NEXT TIME');
    tips.forEach((t, i) => L.push(`  ${i + 1}. ${t}`));
    L.push('');
  }

  L.push(rule, 'FULL TRANSCRIPT', '');
  transcript.forEach((t) =>
    L.push(`${t.speaker === 'customer' ? customer : humanSideLabel(mode)}: ${t.message}`)
  );
  L.push('');
  return L.join('\n');
}

function downloadAnalysis() {
  const data = state.lastReport;
  if (!data) return;
  const stamp = new Date().toISOString().slice(0, 16).replace(':', '');
  const blob = new Blob([buildAnalysisText(data)], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `coaching-report-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ——— Tutorial: guided walkthrough of the screens ———

const tutorial = $('tutorial');
let tutorialStep = 0;

function tutorialGo(i) {
  const steps = [...tutorial.querySelectorAll('.tut-step')];
  tutorialStep = Math.max(0, Math.min(i, steps.length - 1));
  // display:none → block restarts each stage's CSS animation loop on entry
  steps.forEach((s, idx) => s.classList.toggle('is-active', idx === tutorialStep));
  tutorial
    .querySelectorAll('.tut-dot')
    .forEach((d, idx) =>
      d.setAttribute('aria-current', String(idx === tutorialStep))
    );
  $('tut-back').disabled = tutorialStep === 0;
  $('tut-next').hidden = tutorialStep === steps.length - 1;
  $('tut-cta').hidden = tutorialStep !== steps.length - 1;
}

function openTutorial() {
  tutorial.hidden = false;
  document.body.style.overflow = 'hidden';
  tutorialGo(0);
  $('tut-close').focus();
}

function closeTutorial() {
  tutorial.hidden = true;
  document.body.style.overflow = '';
  $('btn-tutorial')?.focus();
}

$('btn-tutorial').addEventListener('click', openTutorial);
$('tut-close').addEventListener('click', closeTutorial);
$('tut-back').addEventListener('click', () => tutorialGo(tutorialStep - 1));
$('tut-next').addEventListener('click', () => tutorialGo(tutorialStep + 1));
$('tut-cta').addEventListener('click', () => {
  closeTutorial();
  show('agents');
});
$('tut-dots').addEventListener('click', (e) => {
  const dot = e.target.closest('.tut-dot');
  if (dot) tutorialGo(Number(dot.dataset.go));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !tutorial.hidden) closeTutorial();
  if (e.key === 'Escape' && !$('drill-intro').hidden) closeDrillIntro();
  if (document.body.dataset.view === 'quiz') handleQuizKey(e);
});

// ——— Inventory Quiz (screen-based; no agent, no API call) ———

const QUIZ_SEEN_KEY = 'eclectic_quiz_seen';
const QUIZ_SEEN_MAX = 40;
let quizState = null;

const quizSeen = () => {
  try {
    return JSON.parse(localStorage.getItem(QUIZ_SEEN_KEY)) || [];
  } catch {
    return [];
  }
};
const quizMarkSeen = (ids) => {
  try {
    const ring = quizSeen().concat(ids);
    localStorage.setItem(QUIZ_SEEN_KEY, JSON.stringify(ring.slice(-QUIZ_SEEN_MAX)));
  } catch {
    /* storage off — degrade to pure crypto-random freshness */
  }
};

// Deterministic-from-seed PRNG so a session is reproducible for debugging yet fresh per run.
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffled = (arr, rnd) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Near-identical pieces — at most one per look-alike group in a Quick round, and never two
// questions with the same answer in one round (so a seller can't be confused / penalized).
const QUIZ_DUP_GROUPS = [
  ['threaded-huichol-skull', 'beaded-huichol-skull-n64'],
  ['macrame-pearl-necklace', 'collar-doble-perla-blanca-cola-sirena', 'pearl-baja-earrings', 'tribal-macrame-earrings'],
  ['chiapas-sandals-dark-magenta', 'chiapas-sandals-harmonic-tan'],
];
const QUIZ_DUP_GROUP = (() => {
  const m = {};
  QUIZ_DUP_GROUPS.forEach((g, gi) => g.forEach((id) => (m[id] = gi)));
  return m;
})();

function buildQuizSet(mode) {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
  const rnd = mulberry32(seed);
  const norm = (s) => String(s).toLowerCase().trim();
  const productById = Object.fromEntries(products.map((p) => [p.id, p]));
  const byProduct = {};
  quiz.forEach((q) => {
    (byProduct[q.productId] = byProduct[q.productId] || []).push(q);
  });
  const seen = new Set(quizSeen());

  // The quiz tests only the unlocked pieces on this store's floor (same rule as the picker).
  const inStore = (pid) => {
    const p = productById[pid];
    if (!p || p.locked) return false;
    const st = p.stores;
    return !state.store || !Array.isArray(st) || st.length === 0 || st.includes(state.store);
  };

  // Choose the products for this round.
  let productIds = shuffled(Object.keys(byProduct).filter(inStore), rnd);
  if (mode !== 'full') {
    const usedGroups = new Set();
    const picked = [];
    for (const pid of productIds) {
      const g = QUIZ_DUP_GROUP[pid];
      if (g !== undefined && usedGroups.has(g)) continue;
      if (g !== undefined) usedGroups.add(g);
      picked.push(pid);
      if (picked.length >= 10) break;
    }
    productIds = picked;
  }

  // Pick one question per product under constraints: cap price at 2, no repeated answer,
  // soft dimension variety, and prefer fresh (unseen) questions.
  const usedAnswers = new Set();
  const dimCount = {};
  let priceCount = 0;
  const ok = (q) =>
    !usedAnswers.has(norm(q.answer)) &&
    !(q.dimension === 'price' && priceCount >= 2) &&
    (dimCount[q.dimension] || 0) < 3;
  const chosen = [];
  for (const pid of productIds) {
    const qs = byProduct[pid];
    const fresh = qs.filter((q) => !seen.has(q.id) && ok(q));
    const allowed = qs.filter(ok);
    const pool = fresh.length ? fresh : allowed.length ? allowed : qs;
    const q = pool[Math.floor(rnd() * pool.length)];
    usedAnswers.add(norm(q.answer));
    dimCount[q.dimension] = (dimCount[q.dimension] || 0) + 1;
    if (q.dimension === 'price') priceCount++;
    chosen.push(q);
  }

  // Each question gets its options shuffled, correct index recomputed (kills "always C").
  const questions = shuffled(chosen, rnd).map((q) => {
    const options = shuffled([q.answer, ...q.distractors], rnd);
    return { ...q, options, correctIndex: options.indexOf(q.answer), product: productById[q.productId] };
  });
  return { mode, seed, questions };
}

function startQuiz(mode) {
  const set = buildQuizSet(mode);
  quizState = { ...set, i: 0, correct: 0, locked: false, results: [] };
  quizMarkSeen(set.questions.map((q) => q.id));
  show('quiz');
  renderQuestion();
}

function renderQuestion() {
  const s = quizState;
  const q = s.questions[s.i];
  s.locked = false;
  $('quiz-count').textContent = `Question ${s.i + 1} of ${s.questions.length}`;
  $('quiz-score').textContent = s.i ? `${s.correct}/${s.i}` : '';
  $('quiz-bar-fill').style.width = `${(s.i / s.questions.length) * 100}%`;

  // Photo only — the name/price/category would give the answer away.
  const thumb = $('quiz-thumb');
  thumb.src = `${q.product.image}${q.product.image.includes('?') ? '&' : '?'}width=480`;
  thumb.alt = 'The piece shown';
  thumb.onerror = () => {
    thumb.onerror = null;
    thumb.src = `/products/${q.product.id}.png`;
  };
  $('quiz-prompt').textContent = q.prompt;

  const fb = $('quiz-feedback');
  fb.hidden = true;
  fb.textContent = '';
  const next = $('btn-quiz-next');
  next.hidden = true;
  next.textContent = s.i + 1 < s.questions.length ? 'Next' : 'See results';

  const wrap = $('quiz-options');
  wrap.textContent = '';
  q.options.forEach((opt, idx) => {
    const b = document.createElement('button');
    b.className = 'quiz-option';
    b.type = 'button';
    b.dataset.idx = String(idx);
    const letter = document.createElement('span');
    letter.className = 'quiz-letter';
    letter.textContent = 'ABCD'[idx];
    const txt = document.createElement('span');
    txt.textContent = opt;
    b.append(letter, txt);
    b.addEventListener('click', () => pickOption(idx));
    wrap.appendChild(b);
  });
}

function pickOption(idx) {
  const s = quizState;
  if (s.locked) return;
  s.locked = true;
  const q = s.questions[s.i];
  const correct = idx === q.correctIndex;
  if (correct) s.correct++;
  s.results.push({ q, correct });

  [...$('quiz-options').querySelectorAll('.quiz-option')].forEach((b, i) => {
    b.disabled = true;
    if (i === q.correctIndex) b.classList.add('is-correct');
    else if (i === idx) b.classList.add('is-wrong');
  });

  const fb = $('quiz-feedback');
  fb.hidden = false;
  fb.className = `quiz-feedback ${correct ? 'good' : 'bad'}`;
  fb.textContent = '';
  const head = document.createElement('strong');
  head.textContent = correct ? 'Correct.' : `Not quite — it’s ${q.answer}.`;
  const why = document.createElement('span');
  why.className = 'quiz-why';
  why.textContent = q.grounding;
  fb.append(head, why);

  $('btn-quiz-next').hidden = false;
  $('btn-quiz-next').focus();
  $('quiz-score').textContent = `${s.correct}/${s.i + 1}`;
}

function nextQuestion() {
  const s = quizState;
  s.i++;
  if (s.i >= s.questions.length) renderQuizResults();
  else renderQuestion();
}

function renderQuizResults() {
  const s = quizState;
  const total = s.questions.length;
  const pct = Math.round((s.correct / total) * 100);
  $('quiz-result-title').textContent =
    pct >= 85 ? 'You know this floor.' : pct >= 60 ? 'Solid — a few stories to firm up.' : 'Worth another lap.';
  $('quiz-result-score').textContent = `${s.correct} of ${total} correct · ${pct}%`;

  const missed = s.results.filter((r) => !r.correct);

  // Save the run to the signed-in seller's record (guests aren't tracked; failures never
  // interrupt the quiz).
  if (state.seller) {
    fetch('/api/quiz-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        score: s.correct,
        total,
        missed: missed.map(({ q }) => ({ product: q.product.name, answer: q.answer })),
      }),
    }).catch(() => {});
  }

  $('quiz-weak-wrap').hidden = missed.length === 0;
  const ul = $('quiz-weak');
  ul.textContent = '';
  missed.forEach(({ q }) => {
    const li = document.createElement('li');
    li.className = 'missed';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = '—';
    const body = document.createElement('span');
    const pt = document.createElement('span');
    pt.className = 'point';
    pt.textContent = `${q.product.name}: ${q.answer}`;
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = q.grounding;
    body.append(pt, note);
    li.append(mark, body);
    ul.appendChild(li);
  });
  show('quiz-results');
}

function handleQuizKey(e) {
  if (!quizState) return;
  const k = e.key.toLowerCase();
  const letterIdx = { a: 0, b: 1, c: 2, d: 3, 1: 0, 2: 1, 3: 2, 4: 3 };
  if (!quizState.locked && k in letterIdx) {
    const opts = $('quiz-options').querySelectorAll('.quiz-option');
    if (opts[letterIdx[k]]) {
      e.preventDefault();
      pickOption(letterIdx[k]);
    }
  } else if ((e.key === 'Enter' || e.key === ' ') && quizState.locked && !$('btn-quiz-next').hidden) {
    e.preventDefault();
    nextQuestion();
  }
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

// ——— Kiosk: who's training ———
// The store tablet is shared; the seller taps their name + PIN before training so every
// session and quiz lands on their record. Guests can still train — nothing is saved.

function updateTraineeChip() {
  const chip = $('trainee-chip');
  if (!chip) return;
  chip.hidden = !state.seller;
  if (state.seller) $('trainee-name').textContent = state.seller.name;
}

async function fetchRoster() {
  if (state.roster) return state.roster;
  try {
    const res = await fetch('/api/roster');
    state.roster = await res.json();
  } catch {
    state.roster = { configured: false, sellers: [] };
  }
  return state.roster;
}

function renderWhoList(sellers) {
  const list = $('who-list');
  list.textContent = '';
  sellers.forEach((s) => {
    const btn = document.createElement('button');
    btn.className = 'card customer-card who-card';
    btn.type = 'button';
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', 'false');
    const body = document.createElement('div');
    body.className = 'card-body';
    const h = document.createElement('h2');
    h.textContent = s.name;
    body.appendChild(h);
    btn.appendChild(body);
    btn.addEventListener('click', () => openPinFor(s));
    list.appendChild(btn);
  });
}

function openPinFor(seller) {
  playTap();
  $('who-pick').hidden = true;
  $('who-pin').hidden = false;
  $('who-pin-name').textContent = `${seller.name} — enter your PIN`;
  $('pin-error').hidden = true;
  const input = $('pin-input');
  input.value = '';
  input.dataset.sellerId = seller.id;
  input.focus();
}

function closePin() {
  $('who-pin').hidden = true;
  $('who-pick').hidden = false;
  $('pin-input').value = '';
  $('pin-error').hidden = true;
}

async function submitPin() {
  const input = $('pin-input');
  const pin = input.value.trim();
  if (!/^\d{4,8}$/.test(pin)) {
    $('pin-error').hidden = false;
    return;
  }
  $('btn-pin-go').disabled = true;
  try {
    const res = await fetch('/api/seller-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seller_id: input.dataset.sellerId, pin }),
    });
    if (!res.ok) {
      $('pin-error').hidden = false;
      input.value = '';
      input.focus();
      return;
    }
    const { seller } = await res.json();
    state.seller = seller;
    updateTraineeChip();
    closePin();
    proceedToTraining();
  } catch {
    $('pin-error').hidden = false;
  } finally {
    $('btn-pin-go').disabled = false;
  }
}

// Start Training: if the roster is configured and nobody is signed in, ask who's training
// first; otherwise go straight to the dashboard. If the database is down, train as guest.
async function startFlow() {
  if (state.seller) {
    proceedToTraining();
    return;
  }
  const roster = await fetchRoster();
  if (roster.configured && roster.sellers.length) {
    renderWhoList(roster.sellers);
    closePin();
    show('who');
  } else {
    proceedToTraining();
  }
}

// The store is a property of the tablet's location — remembered on the device, asked once,
// switchable from the corner chip. Training always runs against one store's floor.
const STORE_KEY = 'ea_store';

function updateStoreChip() {
  const chip = $('store-chip');
  if (!chip) return;
  const s = state.store && storeById[state.store];
  chip.hidden = !s;
  if (s) $('store-name').textContent = s.name;
}

function setStore(id) {
  if (!storeById[id]) return;
  state.store = id;
  try {
    localStorage.setItem(STORE_KEY, id);
  } catch {
    /* private mode — the choice just won't persist across reloads */
  }
  updateStoreChip();
  updateProductVisibility();
}

// After sign-in (or as a guest): pick the store once, then straight to the dashboard.
function proceedToTraining() {
  if (state.store && storeById[state.store]) show('agents');
  else show('store');
}

bindOptionList('store-list', (card) => {
  setStore(card.dataset.storeId);
  show('agents');
});
$('btn-switch-store').addEventListener('click', () => {
  playTap();
  show('store');
});

// Restore the device's store on load, before any training screen can open.
try {
  const saved = localStorage.getItem(STORE_KEY);
  if (saved && storeById[saved]) state.store = saved;
} catch {
  /* ignore */
}
updateStoreChip();
updateProductVisibility();

async function signOutSeller() {
  try {
    await fetch('/api/seller-session', { method: 'DELETE' });
  } catch {
    /* cookie expires on its own */
  }
  state.seller = null;
  updateTraineeChip();
}

// Shared tablet: if nobody touched the app for 30 minutes, drop the seller session so the
// next person doesn't train on someone else's record.
setInterval(() => {
  if (state.seller && Date.now() - state.lastActiveAt > 30 * 60_000) {
    signOutSeller();
  }
}, 60_000);

// On load: restore the seller session carried by the kiosk cookie (if any).
fetch('/api/seller-session')
  .then((r) => r.json())
  .then(({ seller }) => {
    state.seller = seller;
    updateTraineeChip();
  })
  .catch(() => {});

$('btn-start').addEventListener('click', startFlow);
$('btn-switch-seller').addEventListener('click', async () => {
  await signOutSeller();
  startFlow();
});
$('btn-who-guest').addEventListener('click', () => {
  playTap();
  proceedToTraining();
});
$('btn-pin-go').addEventListener('click', submitPin);
$('btn-pin-back').addEventListener('click', closePin);
$('pin-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitPin();
});

// ——— Drill of the day: the weakest dimension, stamped onto the rail ———

// Lowest pass-rate among drills that have runs; ties broken by most-recent order. Falls back
// to a weekday rotation before the seller has any drill history cached.
function pickDrillOfDay(configured) {
  const d = state.progressCache?.drills;
  if (Array.isArray(d) && d.length) {
    const rate = {};
    for (const r of d) {
      const k = r.drill_id;
      (rate[k] ??= { p: 0, n: 0 });
      rate[k].n++;
      if (r.result === 'pass') rate[k].p++;
    }
    const scored = configured.filter((x) => rate[x.id]).map((x) => ({ x, r: rate[x.id].p / rate[x.id].n }));
    if (scored.length) {
      scored.sort((a, b) => a.r - b.r);
      return scored[0].x;
    }
  }
  return configured[new Date().getDay() % configured.length];
}

// Stamp the "Drill of the day" chip onto its card whenever the dashboard opens; if no drill
// is configured yet (all coming-soon), hide the whole rail.
function stampDrillOfDay() {
  const rail = $('drill-rail');
  if (!rail) return;
  const wrap = document.querySelector('.drill-rail-wrap');
  const cfg = drills.filter((d) => isConfigured(d.agent_id));
  if (!cfg.length) {
    if (wrap) wrap.hidden = true;
    return;
  }
  if (wrap) wrap.hidden = false;
  const dod = pickDrillOfDay(cfg);
  rail.querySelectorAll('[data-drill-index]').forEach((card) => {
    const d = drills[Number(card.dataset.drillIndex)];
    const on = !!dod && !!d && d.id === dod.id;
    card.classList.toggle('is-dotd', on);
    if (on) card.setAttribute('aria-label', `${d.label} — drill of the day`);
    else card.removeAttribute('aria-label');
  });
  const chip = $('drill-dotd-chip');
  if (chip) chip.hidden = !dod;
}

// ——— My progress: the seller's own record ———

const fmtMoney = (n) => `$${Number(n).toFixed(Number(n) % 1 ? 2 : 0)}`;
const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function progStat(value, label) {
  const div = document.createElement('div');
  div.className = 'prog-stat';
  const v = document.createElement('strong');
  v.textContent = value;
  const l = document.createElement('span');
  l.textContent = label;
  div.append(v, l);
  return div;
}

// What should this seller practice next? A persona they haven't faced, then the persona
// that keeps getting away, then story work — in that order of urgency.
function practiceNext(sessions, stats) {
  const personas = ['The Haggler', 'The Collector', 'The Goldmine', 'The Hard Case'];
  const singles = sessions.filter((s) => s.mode === 'single');
  const byPersona = new Map(personas.map((p) => [p, { tried: 0, sold: 0 }]));
  singles.forEach((s) => {
    const row = byPersona.get(s.agent_label);
    if (!row) return;
    row.tried++;
    if (s.outcome === 'bought') row.sold++;
  });
  const untried = personas.filter((p) => byPersona.get(p).tried === 0);
  if (sessions.length === 0) {
    return 'Run your first session — The Haggler is a good place to start.';
  }
  if (untried.length) {
    return `You haven't faced ${untried[0]} yet. See how that conversation feels today.`;
  }
  const struggling = personas
    .map((p) => ({ p, ...byPersona.get(p) }))
    .filter((r) => r.tried >= 2)
    .sort((a, b) => a.sold / a.tried - b.sold / b.tried)[0];
  if (struggling && struggling.sold / struggling.tried < 0.5) {
    return `${struggling.p} keeps getting away (${struggling.sold} of ${struggling.tried} closed). Run one more round and hold your ground.`;
  }
  if (stats && stats.story_coverage_pct !== null && Number(stats.story_coverage_pct) < 80) {
    return 'Your story coverage has room to grow — a lap with The Browser or the quiz will firm it up.';
  }
  return 'Solid across the board. Try a Mystery round and read the customer cold.';
}

function renderProgress(data) {
  const { stats, sessions, quizzes } = data;
  $('prog-title').textContent = `${data.seller.name} — my progress`;
  $('prog-sub').textContent = sessions.length
    ? 'Every saved session and quiz, and what to work on next.'
    : 'No sessions saved yet — your first coaching report will land here.';

  // Stat tiles
  const tiles = $('prog-stats');
  tiles.textContent = '';
  const soldRate =
    stats && stats.sales_sessions > 0
      ? `${Math.round((100 * stats.sold) / stats.sales_sessions)}%`
      : '—';
  tiles.append(
    progStat(String(stats?.sessions ?? 0), 'sessions'),
    progStat(soldRate, 'closed'),
    progStat(stats?.avg_ticket_sold != null ? fmtMoney(stats.avg_ticket_sold) : '—', 'avg ticket'),
    progStat(
      stats?.story_coverage_pct != null ? `${stats.story_coverage_pct}%` : '—',
      'story told'
    ),
    progStat(String(data.drill_streak ?? 0), 'drill streak')
  );

  $('prog-next').textContent = practiceNext(sessions, stats);

  // Coaching threads: the latest "work on next" lines across reports, deduped.
  const improve = $('prog-improve');
  improve.textContent = '';
  const seen = new Set();
  sessions
    .flatMap((s) => (Array.isArray(s.improvements) ? s.improvements : []))
    .filter((tip) => {
      const key = tip.toLowerCase().slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3)
    .forEach((tip) => {
      const li = document.createElement('li');
      li.textContent = tip;
      improve.appendChild(li);
    });
  if (!improve.children.length) {
    const li = document.createElement('li');
    li.textContent = 'Nothing yet — finish a session to get your first coaching notes.';
    improve.appendChild(li);
  }

  // Recent weeks: sessions + avg sold ticket per calendar week (last 4 with activity).
  const weeks = new Map();
  sessions.forEach((s) => {
    const d = new Date(s.created_at);
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    const w = weeks.get(key) ?? { n: 0, soldSum: 0, soldN: 0 };
    w.n++;
    if (s.mode === 'single' && s.outcome === 'bought') {
      w.soldSum += Number(s.ticket_amount) || 0;
      w.soldN++;
    }
    weeks.set(key, w);
  });
  const weeksUl = $('prog-weeks');
  weeksUl.textContent = '';
  [...weeks.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 4)
    .forEach(([key, w]) => {
      const li = document.createElement('li');
      li.className = 'told';
      const avg = w.soldN ? ` · ${fmtMoney(w.soldSum / w.soldN)} avg ticket` : '';
      li.textContent = `Week of ${fmtDate(key)} — ${w.n} session${w.n === 1 ? '' : 's'}${avg}`;
      weeksUl.appendChild(li);
    });
  if (!weeksUl.children.length) {
    const li = document.createElement('li');
    li.textContent = 'Your weekly rhythm shows up here.';
    weeksUl.appendChild(li);
  }

  // Quiz record
  const quizUl = $('prog-quiz');
  quizUl.textContent = '';
  if (quizzes.length) {
    const best = quizzes.reduce((m, q) => Math.max(m, (100 * q.score) / q.total), 0);
    const li = document.createElement('li');
    li.className = 'told';
    li.textContent = `Best: ${Math.round(best)}% · last ${quizzes.length} run${quizzes.length === 1 ? '' : 's'}: ${quizzes
      .map((q) => `${q.score}/${q.total}`)
      .join(', ')}`;
    quizUl.appendChild(li);
  } else {
    const li = document.createElement('li');
    li.textContent = 'No quiz runs yet — the photo quiz is a fast way to learn the floor.';
    quizUl.appendChild(li);
  }

  // Drill record: the current streak (also shown as a stat tile) + the last reps.
  const streakEl = $('prog-drill-streak');
  if (streakEl) streakEl.textContent = String(data.drill_streak ?? 0);
  const drillUl = $('prog-drill');
  if (drillUl) {
    drillUl.textContent = '';
    const rows = Array.isArray(data.drills) ? data.drills : [];
    if (rows.length) {
      rows.slice(0, 10).forEach((r) => {
        const li = document.createElement('li');
        const when = document.createElement('span');
        when.className = 'prog-when';
        when.textContent = fmtDate(r.created_at);
        const what = document.createElement('span');
        what.className = 'prog-what';
        const label = drills.find((d) => d.id === r.drill_id)?.label || r.drill_id;
        const pname = products.find((p) => p.id === r.product_id)?.name;
        what.textContent = pname ? `${label} · ${pname}` : label;
        const pass = r.result === 'pass';
        const chip = document.createElement('span');
        chip.className = `rating ${pass ? 'strong' : 'weak'}`;
        chip.textContent = pass ? 'pass' : 'retry';
        // Hover detail: the fix, plus any claims flagged to verify on that rep.
        const tipParts = [];
        if (r.fix) tipParts.push(r.fix);
        if (Array.isArray(r.verify) && r.verify.length) tipParts.push(`Verify: ${r.verify.join(' · ')}`);
        if (tipParts.length) li.title = tipParts.join('\n');
        li.append(when, what, chip);
        drillUl.appendChild(li);
      });
    } else {
      const li = document.createElement('li');
      li.textContent = 'No drills yet — a 2-minute rep is the fastest way to sharpen one move.';
      drillUl.appendChild(li);
    }
  }

  // Session history → tap to reopen the full report
  $('prog-session-count').textContent = sessions.length ? `${sessions.length}` : '';
  const list = $('prog-sessions');
  list.textContent = '';
  sessions.slice(0, 20).forEach((s) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'prog-row';
    const when = document.createElement('span');
    when.className = 'prog-when';
    when.textContent = fmtDate(s.created_at);
    const what = document.createElement('span');
    what.className = 'prog-what';
    what.textContent = `${s.mystery ? 'Mystery — ' : ''}${s.agent_label}${s.product_name ? ` · ${s.product_name}` : ''}`;
    const result = document.createElement('span');
    result.className = `rating ${s.outcome === 'bought' || s.outcome === 'wandered_well' ? 'strong' : s.outcome === 'walked' || s.outcome === 'froze' ? 'weak' : 'partial'}`;
    result.textContent =
      s.mode === 'single' && s.outcome === 'bought'
        ? fmtMoney(s.ticket_amount)
        : (s.outcome ?? '').replaceAll('_', ' ');
    row.append(when, what, result);
    row.addEventListener('click', () => openPastSession(s.id));
    list.appendChild(row);
  });
}

async function openProgress() {
  playTap();
  show('progress');
  $('prog-sub').textContent = 'Loading…';
  try {
    const res = await fetch('/api/my-progress');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    state.progressCache = json; // feeds the Drill-of-day weakest-dimension pick
    renderProgress(json);
  } catch (err) {
    console.error('[trainer] progress failed:', err);
    $('prog-sub').textContent = 'Could not load your progress — check the connection and try again.';
  }
}

async function openPastSession(id) {
  playTap();
  try {
    const res = await fetch(`/api/my-session?id=${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.mystery = false; // a saved report is already revealed
    state.lastReport = data;
    renderReport(data);
    show('report');
  } catch (err) {
    console.error('[trainer] session replay failed:', err);
  }
}

$('btn-my-progress').addEventListener('click', openProgress);
$('btn-begin').addEventListener('click', startSession);
$('btn-end').addEventListener('click', async () => {
  await teardown();
  state.sessionType === 'drill' ? runDrillVerdict() : analyze();
});
$('btn-home').addEventListener('click', endAndGoHome);
$('btn-retry').addEventListener('click', startSession);
$('btn-retry-report').addEventListener('click', () => {
  state.sessionType === 'drill' ? runDrillVerdict() : analyze();
});
$('btn-report-done').addEventListener('click', endAndGoHome);
$('btn-download').addEventListener('click', downloadTranscript);
$('btn-download-analysis').addEventListener('click', downloadAnalysis);

// Drill wiring: intro overlay + the verdict card's retry/done.
$('drill-intro-close')?.addEventListener('click', closeDrillIntro);
$('drill-intro-back')?.addEventListener('click', closeDrillIntro);
$('drill-intro-go')?.addEventListener('click', beginDrill);
$('btn-drill-retry')?.addEventListener('click', retryDrill);
$('btn-drill-done')?.addEventListener('click', endAndGoHome);

// Inventory quiz wiring
document.querySelectorAll('[data-quiz-mode]').forEach((b) =>
  b.addEventListener('click', () => startQuiz(b.dataset.quizMode))
);
$('btn-quiz-next').addEventListener('click', nextQuestion);
$('btn-quiz-again').addEventListener('click', () => show('quiz-setup'));
$('btn-quiz-home').addEventListener('click', endAndGoHome);

$('btn-back').addEventListener('click', () => {
  const view = document.body.dataset.view;
  if (view === 'products') show('agents');
  else if (view === 'agents' || view === 'who' || view === 'progress' || view === 'store')
    show('start');
  else if (view === 'quiz') show('quiz-setup');
  else if (view === 'quiz-setup' || view === 'quiz-results') show('agents');
  else if (view === 'drill-verdict') show('agents');
});

// Dev-only hook so the report screen can be exercised without a live call;
// stripped from production builds.
if (import.meta.env.DEV) {
  window.__trainer = {
    state,
    show,
    renderReport,
    analyze,
    setStatus,
    buildAnalysisText,
    downloadAnalysis,
    showCurrentPiece,
    startDrill: beginDrill,
    makeDrillSeed,
    runDrillVerdict,
    renderDrillVerdict,
  };
}

// Leaving the page mid-call: close the conversation cleanly.
window.addEventListener('pagehide', () => {
  stopReadyMusic(0);
  clearDrillTimers();
  if (state.conversation) {
    const c = state.conversation;
    state.conversation = null;
    c.endSession();
  }
});
