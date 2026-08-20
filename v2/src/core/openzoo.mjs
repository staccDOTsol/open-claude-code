/**
 * OpenZoo wiring — one writer for the zoo env, auth, catalog, and pay walls.
 *
 * This CLI is the product. It talks to the local sidecar on :8402 (preferred)
 * or the OpenZoo gateway with a Stripe subscription Bearer. It never sets or
 * requires ANTHROPIC_API_KEY and never bills api.anthropic.com.
 *
 * Pay lanes (same as OpenZoo — do not invent a second backend):
 *   1) Stripe subscription key → Authorization: Bearer <key> (no x402)
 *   2) Else x402 via the local proxy (or a single 402 pay-wall if no proxy)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const ZOO_PORT = Number(process.env.OPENZOO_PORT || 8402);
export const ZOO_LOCAL_BASE = `http://localhost:${ZOO_PORT}/v1`;
export const ZOO_LOCAL_BASE_LOOPBACK = `http://127.0.0.1:${ZOO_PORT}/v1`;
export const ZOO_DUMMY_TOKEN = 'sk-openzoo';
export const ZOO_GATEWAY = (process.env.OPENZOO_API_BASE || 'https://x402-tokens.fly.dev').replace(/\/+$/, '');
export const BILLING_ORIGIN = 'https://zoo.openzoo.fun';
export const PUBLIC_DOOR = 'https://openzoo.fun';
export const ANTHROPIC_DOT_COM = 'https://api.anthropic.com';

const AUTO_IDS = new Set(['auto', 'openzoo/auto', 'openzoo-auto', 'zoo/auto']);

export class PaymentRequiredError extends Error {
    constructor(message, extras = {}) {
        super(message);
        this.name = 'PaymentRequiredError';
        this.status = 402;
        this.payUrl = extras.payUrl || BILLING_ORIGIN;
        this.body = extras.body || '';
    }
}

export function isZooBase(url) {
    const u = String(url || '').toLowerCase();
    if (!u) return false;
    if (u.includes('api.anthropic.com')) return false;
    return (
        u.includes('localhost') ||
        u.includes('127.0.0.1') ||
        u.includes(`:${ZOO_PORT}`) ||
        u.includes('openzoo') ||
        u.includes('x402-tokens.fly.dev') ||
        u.includes('8402')
    );
}

export function isAutoModel(id) {
    const s = String(id || '').trim().toLowerCase();
    if (!s) return false;
    return AUTO_IDS.has(s);
}

/**
 * Messages URL. When base already ends in /v1 (OpenZoo uses
 * http://127.0.0.1:8402/v1) the path is `${base}/messages`.
 * Never invent https://api.anthropic.com/v1/messages.
 */
export function messagesUrl(base) {
    const raw = String(base || ZOO_LOCAL_BASE).replace(/\/$/, '');
    if (/api\.anthropic\.com/i.test(raw)) {
        // Invert: a leftover Anthropic default is treated as "talk to the zoo".
        return `${ZOO_LOCAL_BASE}/messages`;
    }
    if (raw.endsWith('/messages')) return raw;
    if (raw.endsWith('/v1')) return `${raw}/messages`;
    return `${raw}/v1/messages`;
}

export function modelsUrl(base) {
    const raw = String(base || ZOO_LOCAL_BASE).replace(/\/$/, '');
    if (/api\.anthropic\.com/i.test(raw)) return `${ZOO_LOCAL_BASE}/models`;
    if (raw.endsWith('/models')) return raw;
    if (raw.endsWith('/v1')) return `${raw}/models`;
    return `${raw}/v1/models`;
}

export function infoUrl(base) {
    const raw = String(base || ZOO_LOCAL_BASE).replace(/\/$/, '');
    if (raw.endsWith('/v1')) return `${raw}/info`;
    return `${raw}/v1/info`;
}

export function subscriptionFile(home = os.homedir(), env = process.env) {
    return env.OPENZOO_SUBSCRIPTION_PATH || path.join(home, '.openzoo', 'subscription.json');
}

/**
 * Load the Stripe subscription key. Never log the value.
 * @returns {{ key: string, tier?: string, source: string } | null}
 */
export function loadSubscription({ env = process.env, home = os.homedir(), readFile = fs.readFileSync } = {}) {
    const envKey = String(env.OPENZOO_SUBSCRIPTION_KEY || '').trim();
    if (envKey) {
        return {
            key: envKey,
            tier: env.OPENZOO_SUBSCRIPTION_TIER || null,
            source: 'env',
        };
    }
    const file = subscriptionFile(home, env);
    try {
        const data = JSON.parse(readFile(file, 'utf8'));
        const key = String(data?.key || '').trim();
        if (!key) return null;
        return {
            key,
            tier: data.tier || null,
            tierName: data.tierName || null,
            source: 'file',
        };
    } catch {
        return null;
    }
}

/** Public HUD view — never includes the secret. */
export function subscriptionPublicView(sub) {
    const rec = sub === undefined ? loadSubscription() : sub;
    if (!rec?.key) return { active: false };
    const name = String(rec.tierName || rec.tier || '').trim();
    return {
        active: true,
        tier: rec.tier || null,
        label: name ? `${name} · no x402` : 'Subscription key · no x402',
    };
}

/**
 * Zoo bearer: subscription key if present, else ANTHROPIC_AUTH_TOKEN,
 * else dummy sk-openzoo for the local proxy. Dummy is NOT Anthropic billing.
 */
export function resolveZooBearer(env = process.env) {
    const sub = loadSubscription({ env });
    if (sub?.key) return { token: sub.key, source: 'subscription' };
    const auth = String(env.ANTHROPIC_AUTH_TOKEN || '').trim();
    if (auth) return { token: auth, source: 'auth_token' };
    return { token: ZOO_DUMMY_TOKEN, source: 'zoo_dummy' };
}

/**
 * Auth headers for POST ${BASE_URL}/messages.
 * Bearer only. Never ANTHROPIC_API_KEY. Never x-api-key from a real Anthropic key.
 */
export function anthropicHeaders(env = process.env) {
    const { token, source } = resolveZooBearer(env);
    return {
        headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            Authorization: `Bearer ${token}`,
        },
        source,
        tokenPresent: Boolean(token),
    };
}

/**
 * The same env `openzoo claude` writes (one writer). Mutates `env`.
 * DELETE ANTHROPIC_API_KEY — it would bill api.anthropic.com.
 */
export function applyClaudeZooEnv(env = process.env, { base, port } = {}) {
    const url = base || `http://localhost:${port ?? ZOO_PORT}/v1`;
    delete env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_BASE_URL = url;
    const sub = loadSubscription({ env });
    env.ANTHROPIC_AUTH_TOKEN = sub?.key || env.ANTHROPIC_AUTH_TOKEN || ZOO_DUMMY_TOKEN;
    if (env.OPENZOO_KEEP_COMPACT !== '1') {
        env.DISABLE_COMPACT = env.DISABLE_COMPACT || '1';
        env.DISABLE_AUTO_COMPACT = env.DISABLE_AUTO_COMPACT || '1';
        if (!env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
            env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = env.OPENZOO_CLAUDE_CONTEXT_TOKENS || '1000000';
        }
    }
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY =
        env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY || '1';
    delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    if (!env.CLAUDE_CODE_PERMISSION_MODE) {
        env.CLAUDE_CODE_PERMISSION_MODE = 'bypassPermissions';
    }
    return env;
}

/**
 * Probe GET /v1/info (not /models — models is proxied upstream).
 * Payment is not a boot gate: a 402 here still means the sidecar is up.
 */
export async function probeZooInfo(base, { fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
    const url = infoUrl(base || ZOO_LOCAL_BASE);
    try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        return { ok: true, status: res.status, url };
    } catch {
        return { ok: false, status: 0, url };
    }
}

/**
 * If :8402 answers, apply the zoo env so `claude`/`occ` work without the
 * openzoo wrapper. Still boots if the probe fails — payment is not a boot gate.
 */
export async function detectAndApplyZooEnv(env = process.env, opts = {}) {
    const explicit = env.ANTHROPIC_BASE_URL;
    const alreadyZoo = isZooBase(explicit);
    const forcedAnthropic = explicit && /api\.anthropic\.com/i.test(explicit);

    // Never keep a leftover api.anthropic.com default.
    if (forcedAnthropic) delete env.ANTHROPIC_BASE_URL;

    const candidates = [];
    if (alreadyZoo && explicit) candidates.push(explicit.replace(/\/$/, ''));
    candidates.push(ZOO_LOCAL_BASE, ZOO_LOCAL_BASE_LOOPBACK);

    let applied = false;
    let probed = null;
    for (const base of candidates) {
        const hit = await probeZooInfo(base, opts);
        probed = hit;
        if (hit.ok) {
            applyClaudeZooEnv(env, { base: base.endsWith('/v1') ? base : `${base.replace(/\/$/, '')}` });
            applied = true;
            break;
        }
    }

    if (!applied) {
        // Product path is still the zoo — never api.anthropic.com.
        // Subscription can talk to the gateway; otherwise keep local BASE_URL
        // so a later sidecar start works and we never bill Anthropic.
        const sub = loadSubscription({ env });
        if (sub?.key) {
            applyClaudeZooEnv(env, { base: `${ZOO_GATEWAY}/v1` });
            applied = true;
        } else if (!env.ANTHROPIC_BASE_URL || /api\.anthropic\.com/i.test(env.ANTHROPIC_BASE_URL)) {
            applyClaudeZooEnv(env, { base: ZOO_LOCAL_BASE });
        }
    }

    // Final inversion: API key must stay unset.
    delete env.ANTHROPIC_API_KEY;
    return { applied, probed, baseUrl: env.ANTHROPIC_BASE_URL, zoo: isZooBase(env.ANTHROPIC_BASE_URL) };
}

export function parseModelCatalog(payload) {
    const data = payload?.data || payload?.models || (Array.isArray(payload) ? payload : []);
    const ids = [];
    for (const row of data) {
        const id = typeof row === 'string' ? row : row?.id || row?.name;
        if (!id) continue;
        if (isAutoModel(id)) continue;
        ids.push(String(id));
    }
    return ids;
}

export async function fetchZooModels({
    base,
    env = process.env,
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
} = {}) {
    const url = modelsUrl(base || env.ANTHROPIC_BASE_URL || ZOO_LOCAL_BASE);
    const { headers } = anthropicHeaders(env);
    try {
        const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return [];
        const body = await res.json();
        return parseModelCatalog(body);
    } catch {
        return [];
    }
}

export function pickDefaultModel(catalog) {
    const ids = Array.isArray(catalog) ? catalog.filter(id => !isAutoModel(id)) : [];
    if (!ids.length) return 'openzoo-claude-sonnet';
    const prefer = ids.find(id => /sonnet|fable/i.test(id) && !/opus/i.test(id));
    return prefer || ids[0];
}

export function pickClassifierModel(catalog) {
    const ids = Array.isArray(catalog) ? catalog : [];
    const cheap = ids.find(id => /haiku|mini|small|nano|flash|8b|7b|lightning/i.test(id) && !/opus/i.test(id));
    if (cheap) return cheap;
    const notHuge = ids.find(id => !/opus|claude-opus-5|gpt-5|o3/i.test(id));
    return notHuge || pickDefaultModel(ids);
}

export function pickRaceCandidates(catalog, y = 3) {
    const ids = (Array.isArray(catalog) ? catalog : []).filter(id => id && !isAutoModel(id) && !/opus|claude-opus-5/i.test(id));
    const rank = (id) => (/haiku|mini|flash|lightning|small|nano/i.test(id) ? 0 : /sonnet|fable/i.test(id) ? 1 : 2);
    return [...ids].sort((a, b) => rank(a) - rank(b)).slice(0, y);
}

/**
 * Bind/spill the outbound prefix. When the HUD multiple is under 5, the gate
 * is 2k tokens — not a ~16k prefix. Session-wide ~2× is cheap-vs-cheap.
 */
export function bindMessagesForSend(messages, { tokenGate = 2000, estimate } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const est = estimate || ((m) => Math.ceil(JSON.stringify(m || []).length / 4));
    if (est(list) <= tokenGate) return list;
    let kept = list.slice();
    while (kept.length > 2 && est(kept) > tokenGate) {
        kept = kept.slice(1);
    }
    if (kept.length < list.length) {
        return [{ role: 'user', content: '[bound prefix — zoo spill]' }, ...kept];
    }
    return kept;
}

const CLASSIFIER_MAX_TOKENS = 64;

/**
 * Tiny classifier for Auto race / permission. Never opus. Tiny max_tokens.
 * Heuristic first; optional paid call via classifyFetch.
 */
export function classifyRaceWinnerHeuristic(replies, { bar = 0.7 } = {}) {
    if (!replies?.length) return { model: null, score: 0 };
    const scored = replies.map((r, i) => {
        const text = extractReplyText(r.result);
        const err = /^(Error:|Payment required|OpenZoo API error)/m.test(text);
        const score = err ? 0 : Math.min(1, (text || '').length / 200);
        return { model: r.model, score, index: i, text };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best && best.score >= bar) return best;
    const last = replies[replies.length - 1];
    return { model: last.model, score: 0, reason: 'last_of_x' };
}

export function extractReplyText(result) {
    if (!result) return '';
    if (typeof result === 'string') return result;
    const blocks = result.content || [];
    return blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
}

export async function classifyRaceWinner(replies, opts = {}) {
    const heuristic = classifyRaceWinnerHeuristic(replies, opts);
    const catalog = opts.catalog || [];
    const model = pickClassifierModel(catalog);
    if (/opus/i.test(model)) return heuristic;
    if (typeof opts.classifyFetch !== 'function') return heuristic;

    const excerpts = replies.map((r, i) => `#${i} ${r.model}: ${extractReplyText(r.result).slice(0, 240)}`).join('\n');
    try {
        const res = await opts.classifyFetch({
            model,
            max_tokens: CLASSIFIER_MAX_TOKENS,
            messages: [{
                role: 'user',
                content: `Pick the best reply index (0-${replies.length - 1}) as JSON {"i":n,"score":0-1}.\n${excerpts}`,
            }],
        });
        const text = extractReplyText(res);
        const m = /\{[^}]*\}/.exec(text || '');
        const parsed = m ? JSON.parse(m[0]) : null;
        const i = Number(parsed?.i);
        const score = Number(parsed?.score);
        if (Number.isInteger(i) && replies[i] && score >= (opts.bar ?? 0.7)) {
            return { model: replies[i].model, score };
        }
    } catch {
        // fall through — last of X
    }
    return heuristic;
}

/**
 * Never return openzoo/auto. Resolve Auto via the zoo catalog.
 */
export async function resolveApiModel(requested, opts = {}) {
    const id = String(requested || '').trim();
    if (id && !isAutoModel(id)) return id;
    const catalog = opts.catalog || await fetchZooModels(opts);
    return pickDefaultModel(catalog);
}

/**
 * Extended thinking only when the user asked. Never key off model.includes('opus')
 * — zoo catalog ids (fable/openzoo) would get thinking: {type:enabled} by accident.
 */
export function shouldEnableThinking(model, settings = {}, env = process.env) {
    if (settings.thinking === true || settings.alwaysThinkingEnabled === true) return true;
    if (env.CLAUDE_CODE_THINKING === '1') return true;
    if (settings._thinking === true) return true;
    return false;
}

export function compactDisabled(env = process.env, settings = {}) {
    return (
        env.DISABLE_COMPACT === '1' ||
        env.DISABLE_AUTO_COMPACT === '1' ||
        settings.autoCompactEnabled === false
    );
}

/**
 * 402 is a pay wall. Do not retry, wrap, or walk RPC.
 */
export function paymentErrorFromResponse(status, bodyText) {
    const body = String(bodyText || '');
    const empty = /\b(?:wallet is empty|empty wallet|wallet underfunded|underfunded)\b/i.test(body);
    const msg = empty
        ? `Payment required (HTTP 402) — the wallet is empty. Subscribe or fund at ${BILLING_ORIGIN}`
        : `Payment required (HTTP 402). Subscribe at ${BILLING_ORIGIN} or fund the OpenZoo wallet. The local sidecar on :${ZOO_PORT} pays x402.`;
    return new PaymentRequiredError(msg, { body });
}

export function isPaymentError(err) {
    return err instanceof PaymentRequiredError || err?.status === 402 || /\bHTTP 402\b/.test(String(err?.message || ''));
}

/**
 * Spill multiple = unspilled corpus / sent. NEVER basis==sent (that prints 1.00×).
 */
export function spillMultiple({ corpusChars, sentChars }) {
    const corpus = Number(corpusChars) || 0;
    const sent = Number(sentChars) || 0;
    if (corpus <= 0 || sent <= 0) return null;
    return corpus / sent;
}

export function parseSpillHeaders(headers) {
    if (!headers) return { corpusChars: 0, sentChars: 0, bound: false };
    const get = typeof headers.get === 'function'
        ? (k) => headers.get(k)
        : (k) => headers[k] ?? headers[k.toLowerCase()];
    const corpus = parseInt(get('x-hrr-corpus-chars') || get('x-openzoo-corpus-chars') || '0', 10) || 0;
    const sent = parseInt(get('x-hrr-sent-chars') || get('x-openzoo-sent-chars') || '0', 10) || 0;
    const bound = Boolean(get('x-hrr-bound') || get('x-openzoo-bound') || corpus > 0);
    return { corpusChars: corpus, sentChars: sent, bound };
}

export function bindTokenGate(sessionMultiple) {
    // When the green HUD multiple is under 5, bind/spill at 2k tokens.
    if (sessionMultiple == null || sessionMultiple < 5) return 2000;
    return 16000;
}

export function createSpillHud() {
    return {
        calls: 0,
        spilledCalls: 0,
        corpusChars: 0,
        sentChars: 0,
        lastMultiple: null,
        note(headers, fallbackSent = 0) {
            const parsed = parseSpillHeaders(headers);
            const sent = parsed.sentChars || fallbackSent;
            const corpus = parsed.corpusChars;
            this.calls += 1;
            if (parsed.bound || corpus > 0) this.spilledCalls += 1;
            this.corpusChars += corpus;
            this.sentChars += sent;
            this.lastMultiple = spillMultiple({ corpusChars: corpus, sentChars: sent });
            return this;
        },
        sessionMultiple() {
            return spillMultiple({ corpusChars: this.corpusChars, sentChars: this.sentChars });
        },
        format() {
            const session = this.sessionMultiple();
            const parts = [];
            if (session != null) parts.push(`${session.toFixed(2)}× session`);
            if (this.spilledCalls > 0) parts.push(`spilled ×${this.spilledCalls}`);
            return parts.join(' · ');
        },
    };
}

/**
 * Cheap race: first `firstX` replies back out of `candidates`, then a
 * classifier compares those X. If none clear the bar, take the last of those X.
 * Do not wait until X pass a bar.
 */
export async function raceFirstX(candidates, {
    runOne,
    classify,
    firstX = 2,
    bar = 0.7,
} = {}) {
    const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (!list.length) throw new Error('raceFirstX: no candidates');
    if (list.length === 1) {
        const result = typeof runOne === 'function' ? await runOne(list[0]) : null;
        return { winner: list[0], replies: result ? [{ model: list[0], result }] : [], reason: 'single' };
    }

    // First X replies back out of Y — classify then; do not wait for the rest
    // of Y, and do not wait until X pass a bar.
    const replies = [];
    await new Promise((resolve) => {
        let done = false;
        let pending = list.length;
        const finish = () => { if (!done) { done = true; resolve(); } };
        for (const model of list) {
            Promise.resolve()
                .then(() => runOne(model))
                .then((result) => {
                    if (done) return;
                    replies.push({ model, result });
                    if (replies.length >= firstX) finish();
                })
                .catch(() => {})
                .finally(() => {
                    pending -= 1;
                    if (pending <= 0) finish();
                });
        }
    });

    if (!replies.length) throw new Error('raceFirstX: no replies');
    if (replies.length === 1) return { winner: replies[0].model, replies, reason: 'only_reply' };

    if (typeof classify === 'function') {
        const pick = await classify(replies, { bar });
        if (pick?.model && (pick.score == null || pick.score >= bar)) {
            return { winner: pick.model, replies, reason: 'classified', score: pick.score };
        }
    }
    return { winner: replies[replies.length - 1].model, replies, reason: 'last_of_x' };
}
