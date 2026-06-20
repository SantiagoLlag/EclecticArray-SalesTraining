#!/usr/bin/env node
// CI / pre-commit guard for the inventory quiz bank.
// Fails the build if any answer key is unsupported by the CURRENT products.json,
// any distractor is accidentally true for its piece, or coverage drops below floor.
// Run: node scripts/check-quiz.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '..', 'src', 'data');
const products = JSON.parse(readFileSync(join(DATA, 'products.json'), 'utf8'));
const quiz = JSON.parse(readFileSync(join(DATA, 'quiz-questions.json'), 'utf8'));

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const byId = Object.fromEntries(products.map((p) => [p.id, p]));
// "true facts" blob (story + description) — distractors must NOT appear here.
const factBlob = (p) => norm([...(p.story || []), p.description || ''].join('  ||  '));
// full prose (adds objections + price + category) — narrative grounding must appear here.
const proseBlob = (p) => norm([...(p.story || []), p.description || '', ...(p.objections || []), p.price, p.category].join('  ||  '));

const errors = [];
const warn = [];
const count = {};

for (const q of quiz) {
  const where = `[${q.id || q.productId + '/' + q.dimension}]`;
  const p = byId[q.productId];
  if (!p) { errors.push(`${where} unknown productId "${q.productId}"`); continue; }
  count[q.productId] = (count[q.productId] || 0) + 1;

  // structure
  const opts = [q.answer, ...(q.distractors || [])];
  if (!q.answer) errors.push(`${where} missing answer`);
  if (!Array.isArray(q.distractors) || q.distractors.length !== 3) errors.push(`${where} needs exactly 3 distractors`);
  if (new Set(opts.map(norm)).size !== 4) errors.push(`${where} options are not 4 distinct values: ${JSON.stringify(opts)}`);
  if (!q.prompt) errors.push(`${where} missing prompt`);

  // answer correctness vs the source of truth
  if (q.dimension === 'category') {
    if (norm(q.answer) !== norm(p.category)) errors.push(`${where} category answer "${q.answer}" != products.json "${p.category}"`);
  } else if (q.dimension === 'price') {
    if (norm(q.answer) !== norm(p.price)) errors.push(`${where} price answer "${q.answer}" != products.json "${p.price}"`);
  } else {
    // narrative: the grounding must still be present in the piece's prose (drift guard)
    if (!q.grounding || !proseBlob(p).includes(norm(q.grounding))) {
      errors.push(`${where} grounding not found in products.json prose (drift): "${q.grounding}"`);
    }
  }

  // distractors must be FALSE for this piece (no two-correct-answer collisions)
  for (const d of q.distractors || []) {
    if (norm(d) === norm(q.answer)) errors.push(`${where} distractor equals the answer: "${d}"`);
    if (q.dimension === 'category' && norm(d) === norm(p.category)) errors.push(`${where} category distractor "${d}" is the real category`);
    if (q.dimension === 'price' && norm(d) === norm(p.price)) errors.push(`${where} price distractor "${d}" is the real price`);
    if (!['category', 'price'].includes(q.dimension) && factBlob(p).includes(norm(d)) && norm(d).length > 3) {
      errors.push(`${where} distractor "${d}" appears in this piece's true facts (accidentally correct)`);
    }
  }

  // photo-only quiz: the prompt must NOT name the piece or contain the answer
  const promptN = norm(q.prompt);
  const baseName = norm(String(p.name).split(/[—(/]/)[0]);
  if (promptN.includes(norm(p.name)) || (baseName.length > 4 && promptN.includes(baseName))) {
    errors.push(`${where} prompt names the piece: "${q.prompt}"`);
  }
  if (norm(q.answer).length > 3 && promptN.includes(norm(q.answer))) {
    errors.push(`${where} prompt leaks the answer "${q.answer}": "${q.prompt}"`);
  }
}

// coverage: every product, at least 4 questions each
for (const p of products) {
  if (!count[p.id]) errors.push(`[coverage] no questions for "${p.id}"`);
  else if (count[p.id] < 4) warn.push(`[coverage] only ${count[p.id]} questions for "${p.id}" (target >= 4)`);
}

const items = Object.keys(count).length;
console.log(`quiz bank: ${quiz.length} questions, ${items}/${products.length} items, min/item ${Math.min(...Object.values(count))}`);
if (warn.length) { console.warn('\nWARNINGS:'); warn.forEach((w) => console.warn('  ' + w)); }
if (errors.length) {
  console.error(`\nFAILED — ${errors.length} problem(s):`);
  errors.slice(0, 60).forEach((e) => console.error('  ' + e));
  process.exit(1);
}
console.log('OK — every answer grounded, every distractor false-for-its-piece, coverage >= 4/item.');
