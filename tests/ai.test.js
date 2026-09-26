/**
 * AI delivery risk assessment: server route, validation and fallback.
 * OpenAI is mocked — these tests never call the real API.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.mjs';
import { seedDatabase } from '../server/seed.mjs';
import { validateAssessment } from '../server/ai-assessment.mjs';

let mockReply = null;
let lastRequest = null;
const aiFetch = async (url, opts) => {
  lastRequest = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
  if (mockReply instanceof Error) throw mockReply;
  return { ok: true, json: async () => ({ choices: [{ message: { content: mockReply } }] }) };
};

let withKey;
let noKey;
before(async () => {
  withKey = await startServer({ port: 0, env: { NODE_ENV: 'test', IMAQ_ADMIN_PIN: '2026', OPENAI_API_KEY: 'sk-test' }, quiet: true, aiFetch });
  noKey = await startServer({ port: 0, env: { NODE_ENV: 'test', IMAQ_ADMIN_PIN: '2026' }, quiet: true });
  await seedDatabase(withKey.db);
  await seedDatabase(noKey.db);
});
after(async () => { await withKey?.close(); await noKey?.close(); });

const assess = (srv, id, pin = '2026') => fetch(`http://localhost:${srv.port}/api/households/${id}/ai-assessment`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(pin ? { 'X-Imaq-Admin-Pin': pin } : {}) }, body: '{}',
}).then(async (r) => ({ status: r.status, json: await r.json() }));

test('AI: municipality PIN required; unknown household → 404', async () => {
  assert.equal((await assess(noKey, 'H-024', null)).status, 401);
  assert.equal((await assess(noKey, 'H-999')).status, 404);
});

test('AI: without OPENAI_API_KEY the rule-based priority is returned (app keeps working)', async () => {
  const r = await assess(noKey, 'H-037');
  assert.equal(r.status, 200);
  assert.equal(r.json.source, 'rules');
  assert.equal(r.json.fallbackReason, 'not_configured');
  assert.equal(r.json.priority, 'HIGH');
  assert.ok(r.json.reason && r.json.recommendedAction);
});

test('AI: a valid structured answer is returned; context comes from existing household data; key never leaves the server', async () => {
  mockReply = JSON.stringify({ priority: 'HIGH', reason: 'Six residents use about 360 L/day.', recommendedAction: 'Plan delivery today.', estimatedTimeToEmpty: 'about 3 days' });
  const r = await assess(withKey, 'H-024');
  assert.equal(r.json.source, 'openai');
  assert.equal(r.json.priority, 'HIGH');
  assert.equal(r.json.estimatedTimeToEmpty, 'about 3 days');
  assert.ok(!JSON.stringify(r.json).includes('sk-test'), 'key not in response');
  assert.equal(lastRequest.auth, 'Bearer sk-test');
  assert.equal(lastRequest.body.temperature, 0);
  assert.equal(lastRequest.body.response_format.type, 'json_schema');
  const ctx = JSON.parse(lastRequest.body.messages[1].content.split('\n').slice(1).join('\n'));
  assert.equal(ctx.householdId, 'H-024');
  assert.equal(ctx.residents, 6);
  assert.equal(typeof ctx.tankLevelPercent, 'number');
  assert.equal(ctx.dailyUseLitres, 360);
});

test('AI: unknown tank level → no time-to-empty even if the model returns one', async () => {
  mockReply = JSON.stringify({ priority: 'MEDIUM', reason: 'Monitor offline.', recommendedAction: 'Check the monitor.', estimatedTimeToEmpty: 'about 2 days' });
  const r = await assess(withKey, 'H-044');
  assert.equal(r.json.source, 'openai');
  assert.equal(r.json.estimatedTimeToEmpty, null);
});

test('AI: invalid JSON, wrong enum or network failure → rule-based fallback', async () => {
  for (const [reply, reason] of [['not json', 'invalid_response'], [JSON.stringify({ priority: 'URGENT', reason: 'x', recommendedAction: 'y', estimatedTimeToEmpty: null }), 'invalid_response'], [new Error('down'), 'unavailable']]) {
    mockReply = reply;
    const r = await assess(withKey, 'H-024');
    assert.equal(r.status, 200);
    assert.equal(r.json.source, 'rules');
    assert.equal(r.json.fallbackReason, reason);
  }
});

test('AI: output validation', () => {
  assert.deepEqual(validateAssessment({ priority: 'LOW', reason: ' ok ', recommendedAction: 'none', estimatedTimeToEmpty: null }), { priority: 'LOW', reason: 'ok', recommendedAction: 'none', estimatedTimeToEmpty: null });
  assert.equal(validateAssessment({ priority: 'LOW', reason: '', recommendedAction: 'x' }), null);
  assert.equal(validateAssessment({ priority: 'low', reason: 'a', recommendedAction: 'x' }), null);
  assert.equal(validateAssessment(null), null);
  assert.equal(validateAssessment([]), null);
});
