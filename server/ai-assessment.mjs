/**
 * AI Delivery Risk Assessment — DECISION SUPPORT ONLY.
 *
 * Builds a small context from the household's EXISTING derived state (the same
 * selectors every role uses), asks OpenAI for a structured assessment, validates
 * it, and falls back to Imaq's rule-based priority if the key is missing, the
 * call fails/times out, or the answer is invalid. It never writes anything: the
 * operator decides and acts.
 *
 * Env: OPENAI_API_KEY (required for AI), OPENAI_MODEL (optional, default gpt-4o-mini).
 */
import { estimateConsumption, litresFromLevel } from '../js/core/tank.js';

export const AI_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const TIMEOUT_MS = 15_000;
const HOUR = 3600_000;

const SYSTEM_PROMPT = [
  'You assist municipal water-delivery operators in prioritizing household water deliveries.',
  'Analyze only the supplied data. Never invent missing information; if a value is null or unknown, say so instead of guessing.',
  'Return structured JSON only. Your assessment is advisory and must not automatically trigger a delivery.',
  'Consider the current water level, estimated litres, daily consumption and its recent trend, household size, vulnerability, last and next scheduled delivery, and any low-water report.',
  'Water-condition status (turbidity/conductivity) is about water quality, not water supply: do not treat it as low water.',
  'A monitor problem means the tank level is unknown, not empty.',
  'Explain the main reason for the priority in plain language in one short sentence (max 30 words), and give one short operational recommendation (max 20 words).',
  'estimatedTimeToEmpty: a short approximate phrase such as "about 3 days" ONLY if the tank level and daily use are both known; otherwise null.',
].join(' ');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['priority', 'reason', 'recommendedAction', 'estimatedTimeToEmpty'],
  properties: {
    priority: { type: 'string', enum: AI_PRIORITIES },
    reason: { type: 'string' },
    recommendedAction: { type: 'string' },
    estimatedTimeToEmpty: { type: ['string', 'null'] },
  },
};

const round = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

function levelAt(readings, ts) {
  let best = null;
  for (const r of readings) {
    if (typeof r.tankLevel !== 'number') continue;
    if (Math.abs(r.timestamp - ts) <= 45 * 60_000 && (!best || Math.abs(r.timestamp - ts) < Math.abs(best.timestamp - ts))) best = r;
  }
  return best ? round(best.tankLevel) : null;
}

/** Only facts Imaq already has. Unknown stays null. */
export function buildContext(h, now) {
  const cap = h.meta.tankCapacityLitres;
  const recent = h.readings.filter((r) => r.timestamp >= now - 12 * HOUR);
  const recentUse = estimateConsumption(recent.map((r) => ({ ts: r.timestamp, litres: litresFromLevel(r.tankLevel, cap) })), null, { minHours: 6 });
  const levelKnown = typeof h.level === 'number';
  return {
    householdId: h.id,
    residents: h.meta.occupants,
    vulnerability: h.meta.vulnerability || 'none',
    tankCapacityLitres: cap,
    tankLevelPercent: levelKnown ? round(h.level) : null,
    estimatedLitresInTank: levelKnown ? round(h.litres) : null,
    tankLevelPercentHistory: levelKnown ? { '24hAgo': levelAt(h.readings, now - 24 * HOUR), '12hAgo': levelAt(h.readings, now - 12 * HOUR), '6hAgo': levelAt(h.readings, now - 6 * HOUR), now: round(h.level) } : null,
    dailyUseLitres: h.consumption.litresPerDay,
    dailyUseSource: h.consumption.source === 'measured' ? 'estimated from the last 48 h of tank readings' : h.consumption.source === 'configured' ? 'configured household estimate (not enough readings)' : 'unknown',
    last12hUseLitresPerDay: recentUse.source === 'measured' ? recentUse.litresPerDay : null,
    imaqEstimatedDaysRemaining: typeof h.days === 'number' ? round(h.days, 1) : null,
    tankMonitorStatus: h.monitor,
    lastDeliveryHoursAgo: h.lastDelivery ? round((now - h.lastDelivery.ts) / HOUR, 1) : null,
    lastDeliveryLitres: h.lastDelivery ? h.lastDelivery.litres : null,
    scheduledDeliveryIntervalDays: h.meta.deliveryIntervalDays,
    nextScheduledDeliveryInHours: round((h.dueTs - now) / HOUR, 1),
    plannedDelivery: h.plan ? { when: h.plan.when, truck: h.plan.truckId, delayed: h.plan.delayed, reassignedFromBrokenTruck: h.plan.reassigned } : null,
    residentReportedLowWaterLight: !!h.lowWaterReported,
    waterConditionStatus: h.status,
    ruleBasedPriority: h.priority.level,
    dataNote: 'Prototype: tank readings are synthetic.',
  };
}

/** Strict validation of the model output. Returns a clean object or null. */
export function validateAssessment(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const str = (x, max) => (typeof x === 'string' && x.trim() && x.trim().length <= max ? x.trim() : null);
  const priority = AI_PRIORITIES.includes(v.priority) ? v.priority : null;
  const reason = str(v.reason, 400);
  const recommendedAction = str(v.recommendedAction, 300);
  if (!priority || !reason || !recommendedAction) return null;
  const eta = v.estimatedTimeToEmpty == null ? null : str(v.estimatedTimeToEmpty, 60);
  return { priority, reason, recommendedAction, estimatedTimeToEmpty: eta };
}

const RULE_REASON = {
  days: (h) => (typeof h.days === 'number' ? `about ${h.days < 1 ? 'less than 1' : Math.round(h.days)} day(s) of water left` : null),
  scheduleOnly: () => 'tank level unknown, planned by delivery schedule',
  lowWater: () => 'resident reported the low-water light',
  vulnerability: (h) => `${h.meta.vulnerability} in household`,
  delayed: () => 'delivery delayed',
  overdue: () => 'delivery overdue',
};
const RULE_ACTION = {
  HIGH: 'Keep this household at the top of today’s delivery plan.',
  MEDIUM: 'Plan a delivery soon and watch the tank level.',
  LOW: 'No change to the regular delivery schedule.',
};

/** Existing rule-based priority, in the same response shape. */
export function ruleBasedAssessment(h, fallbackReason) {
  const parts = h.priority.reasons.map((r) => RULE_REASON[r] && RULE_REASON[r](h)).filter(Boolean);
  const days = typeof h.days === 'number' ? (h.days < 1 ? 'less than 1 day' : `about ${Math.round(h.days)} day${Math.round(h.days) === 1 ? '' : 's'}`) : null;
  return {
    source: 'rules',
    fallbackReason,
    priority: h.priority.level,
    reason: `Rule-based priority: ${parts.join('; ') || 'no specific signal'}.`,
    recommendedAction: RULE_ACTION[h.priority.level],
    estimatedTimeToEmpty: days,
  };
}

export async function assessHousehold(h, { now = Date.now(), env = process.env, fetchImpl = globalThis.fetch, lang = 'en' } = {}) {
  const key = env.OPENAI_API_KEY;
  if (!key) return ruleBasedAssessment(h, 'not_configured');
  const context = buildContext(h, now);
  const model = env.OPENAI_MODEL || 'gpt-4o-mini';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        seed: 7,
        max_tokens: 300,
        response_format: { type: 'json_schema', json_schema: { name: 'delivery_risk_assessment', strict: true, schema: SCHEMA } },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT + (lang === 'fr' ? ' Write reason, recommendedAction and estimatedTimeToEmpty in French.' : '') },
          { role: 'user', content: `Household data (JSON):\n${JSON.stringify(context)}` },
        ],
      }),
    });
    if (!res.ok) return ruleBasedAssessment(h, `openai_http_${res.status}`);
    const body = await res.json();
    let parsed = null;
    try { parsed = JSON.parse(body?.choices?.[0]?.message?.content ?? ''); } catch { parsed = null; }
    const valid = validateAssessment(parsed);
    if (!valid) return ruleBasedAssessment(h, 'invalid_response');
    // Never show a time-to-empty that Imaq's own data cannot support.
    if (context.tankLevelPercent == null || !context.dailyUseLitres) valid.estimatedTimeToEmpty = null;
    return { source: 'openai', model, ...valid };
  } catch (e) {
    return ruleBasedAssessment(h, e && e.name === 'AbortError' ? 'timeout' : 'unavailable');
  } finally {
    clearTimeout(timer);
  }
}
