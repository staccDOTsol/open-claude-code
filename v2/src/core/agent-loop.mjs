/**
 * Agent Loop — async generator yielding 13 event types.
 * Handles streaming, tool calls, thinking, auto-compaction, hooks, multi-provider.
 */
import { streamResponse, accumulateStream } from './streaming.mjs';
import { ContextManager } from './context-manager.mjs';
import { buildSystemPrompt } from './system-prompt.mjs';
import {
    anthropicHeaders,
    bindMessagesForSend,
    bindTokenGate,
    classifyRaceWinner,
    isZooBase,
    compactDisabled,
    createSpillHud,
    isAutoModel,
    isPaymentError,
    messagesUrl,
    paymentErrorFromResponse,
    messagesWereBound,
    pickRaceCandidates,
    raceFirstX,
    resolveApiModel,
    shouldEnableThinking,
    ZOO_LOCAL_BASE,
} from './openzoo.mjs';
import { persistUserTurn, ToolRepeatGuard, isHarnessUserText, rewriteFindCommand, rejectHarnessBash } from './savings.mjs';

/** Maximum number of consecutive tool-use continuation turns before aborting. */
const MAX_TOOL_RECURSION_DEPTH = 50;

export function createAgentLoop({ model, tools, permissions, settings, hooks, cascade = null, sessionManager = null }) {
    const contextManager = new ContextManager(settings.maxContextTokens || 180000, {
        disableCompact: compactDisabled(process.env, settings),
    });
    const repeatGuard = new ToolRepeatGuard();
    const spillHud = createSpillHud();

    // Build system prompt using the new builder
    const promptResult = buildSystemPrompt({
        cwd: process.cwd(),
        tools: tools.list?.() || [],
        override: settings.systemPromptOverride,
        addDirs: settings.addDirs,
    });

    const state = {
        messages: [],
        systemPrompt: promptResult.full,
        turnCount: 0,
        tokenUsage: { input: 0, output: 0 },
        model,
        tools,
        _contextManager: contextManager,
        _cascade: cascade,
        _sessionManager: sessionManager,
        _repeatGuard: repeatGuard,
        _spillHud: spillHud,
    };

    // Self-optimization bookkeeping for the current top-level task (opt-in).
    let _optTask = null; // { model, complexity, startedAt, tokensAtStart }

    /** Record the outcome of the current task, if self-optimization is on. */
    function recordOptOutcome(success) {
        if (!cascade || !_optTask) return;
        const inputDelta = state.tokenUsage.input - _optTask.tokensAtStart.input;
        const outputDelta = state.tokenUsage.output - _optTask.tokensAtStart.output;
        try {
            cascade.recordOutcome({
                model: _optTask.model,
                success,
                latencyMs: Date.now() - _optTask.startedAt,
                inputTokens: inputDelta >= 0 ? inputDelta : 0,
                outputTokens: outputDelta >= 0 ? outputDelta : 0,
                complexity: _optTask.complexity,
                task: _optTask.task,
            });
        } catch { /* best-effort */ }
        _optTask = null;
    }

    async function* run(userMessage, options = {}) {
        const depth = (options._depth || 0);

        // Guard against runaway tool-call recursion
        if (depth >= MAX_TOOL_RECURSION_DEPTH) {
            yield { type: 'error', message: `Max tool recursion depth (${MAX_TOOL_RECURSION_DEPTH}) reached. Stopping to prevent infinite loop.` };
            yield { type: 'stop', reason: 'max_recursion' };
            return;
        }

        // Add user message (skip for continuation turns). Persist BEFORE any
        // API call or TUI refresh — refresh must not forget the turn.
        if (userMessage && !options.continuation) {
            if (isHarnessUserText(userMessage)) {
                yield { type: 'error', message: 'Ask-mode text harness is disabled. Use Claude Code tools, not RUN:/WRITE:/SPAWN:.' };
                yield { type: 'stop', reason: 'harness_rejected' };
                return;
            }
            const last = state.messages[state.messages.length - 1];
            const already = last?.role === 'user' && last.content === userMessage;
            if (!already) {
                state.messages = contextManager.addMessage(state.messages, {
                    role: 'user',
                    content: userMessage,
                });
                state.turnCount++;
            }
            // Persist BEFORE any API call (and before a TUI refresh forgets it).
            if (sessionManager) persistUserTurn(sessionManager, state);

            // Opt-in cost-cascade routing: pick the cheapest good-enough model
            // for this task and record outcome bookkeeping. Default path (no
            // cascade) leaves state.model exactly as constructed.
            if (cascade) {
                const route = cascade.decide(userMessage);
                state.model = route.model;
                state._lastRoute = route;
                _optTask = {
                    model: route.model,
                    complexity: route.complexity,
                    startedAt: Date.now(),
                    tokensAtStart: { input: state.tokenUsage.input, output: state.tokenUsage.output },
                    task: String(userMessage).slice(0, 120),
                };
            }
        }

        // Check max turns
        if (settings.maxTurns && state.turnCount > settings.maxTurns) {
            yield { type: 'error', message: `Max turns (${settings.maxTurns}) reached.` };
            yield { type: 'stop', reason: 'max_turns' };
            return;
        }

        // Auto-compact if needed (zoo: DISABLE_COMPACT — proxy already spills)
        if (!compactDisabled(process.env, settings) && contextManager.shouldCompact(state.messages)) {
            yield { type: 'compaction', count: contextManager.compactionCount + 1 };
            state.messages = contextManager.compact(state.messages);
        }

        yield { type: 'stream_request_start', turn: state.turnCount };

        // Detect provider and call API. Use state.model so an opt-in cascade
        // pick takes effect; defaults to the constructed model otherwise.
        const activeModel = state.model || model;
        const provider = detectProvider(activeModel);
        let response;

        try {
            if (settings.stream !== false) {
                // Streaming mode
                response = await callApiStreaming(provider, activeModel, state, tools.list(), settings);
                const collectedContent = [];
                let currentText = '';
                let currentThinking = '';

                for await (const event of response.events) {
                    if (event.type === 'content_block_start') {
                        if (event.content_block?.type === 'thinking') {
                            currentThinking = '';
                        }
                    } else if (event.type === 'content_block_delta') {
                        if (event.delta?.type === 'text_delta') {
                            currentText += event.delta.text;
                            yield { type: 'stream_event', text: event.delta.text };
                        } else if (event.delta?.type === 'thinking_delta') {
                            currentThinking += event.delta.thinking;
                            yield { type: 'thinking', text: event.delta.thinking };
                        }
                    } else if (event.type === 'ping') {
                        // Keepalive, ignore
                    }
                }

                // Use the accumulated message
                response = response.accumulated;
            } else {
                // Non-streaming mode
                response = await callApi(provider, activeModel, state, tools.list(), settings);
            }
        } catch (err) {
            recordOptOutcome(false);
            if (isPaymentError(err)) {
                yield { type: 'error', message: err.message, paymentRequired: true, status: 402 };
                yield { type: 'stop', reason: 'payment_required' };
                return;
            }
            yield { type: 'error', message: err.message };
            return;
        }

        // Track token usage
        if (response.usage) {
            state.tokenUsage.input += response.usage.input_tokens || 0;
            state.tokenUsage.output += response.usage.output_tokens || 0;
        }

        // Build assistant message for history
        const assistantMessage = { role: 'assistant', content: response.content };
        state.messages.push(assistantMessage);

        // Process content blocks
        const toolUseBlocks = [];

        for (const block of response.content || []) {
            if (block.type === 'text') {
                yield { type: 'assistant', content: block.text };
            }

            if (block.type === 'thinking') {
                yield { type: 'thinking_complete', thinking: block.thinking };
            }

            if (block.type === 'tool_use') {
                toolUseBlocks.push(block);
            }
        }

        // Process tool calls
        if (toolUseBlocks.length > 0) {
            const toolResults = [];

            for (const block of toolUseBlocks) {
                // Run pre-tool hooks
                if (hooks) {
                    const hookResult = await hooks.runPreToolUse(block.name, block.input);
                    if (!hookResult.allow) {
                        yield { type: 'hookPermissionResult', tool: block.name, allowed: false, message: hookResult.message };
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: block.id,
                            content: `Blocked by hook: ${hookResult.message}`,
                        });
                        continue;
                    }
                }

                // Check permission
                const allowed = await permissions.check(block.name, block.input);
                if (!allowed) {
                    yield { type: 'hookPermissionResult', tool: block.name, allowed: false };
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: block.id,
                        content: 'Permission denied',
                    });
                    continue;
                }

                // Execute tool
                yield { type: 'tool_progress', tool: block.name, status: 'running' };

                let result;
                const input = { ...block.input };
                if (block.name === 'Bash' && input.command) {
                    const harness = rejectHarnessBash(input.command);
                    if (harness) {
                        result = harness;
                    } else {
                        input.command = rewriteFindCommand(input.command, settings.cwd || process.cwd());
                    }
                }
                const skip = result ? null : repeatGuard.check(block.name, input);
                if (skip?.skip) {
                    result = skip.message;
                } else if (!result) {
                    try {
                        result = await tools.call(block.name, input);
                    } catch (err) {
                        result = `Tool error: ${err.message}`;
                    }
                    repeatGuard.record(block.name, input, result);
                }

                // Run post-tool hooks
                if (hooks) {
                    result = await hooks.runPostToolUse(block.name, result);
                }

                yield { type: 'result', tool: block.name, result };

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: block.id,
                    content: typeof result === 'string' ? result : JSON.stringify(result),
                });
            }

            // Add tool results as a single user message
            state.messages.push({ role: 'user', content: toolResults });

            // Recursive: continue the loop after tool execution
            yield* run(null, { continuation: true, _depth: depth + 1 });
            return;
        }

        // No tool calls — check stop hooks
        if (hooks) {
            const allowStop = await hooks.runStop();
            if (!allowStop) {
                // Continue via tools — never inject NUDGE / RUN:/WRITE: harness text.
                yield* run(null, { continuation: true, _depth: depth + 1 });
                return;
            }
        }

        // Task completed normally — record a successful outcome (opt-in).
        recordOptOutcome(true);

        yield { type: 'stop', reason: response.stop_reason || 'end_turn' };
    }

    return { run, state, persist: () => sessionManager?.save(state) };
}

export function detectProvider(model, env = process.env) {
    // Zoo product path: every catalog id POSTs ${BASE_URL}/messages. gpt-* /
    // gemini ids from OpenRouter must not take the OpenAI/Google key lanes.
    if (isZooBase(env.ANTHROPIC_BASE_URL) || !env.ANTHROPIC_BASE_URL) return 'anthropic';
    if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
    if (model.startsWith('gemini')) return 'google';
    return 'anthropic';
}

async function callApi(provider, model, state, toolDefs, settings) {
    const callers = { anthropic: callAnthropic, openai: callOpenAI, google: callGoogle };
    const caller = callers[provider] || callers.anthropic;
    return caller(model, state, toolDefs, settings, false);
}

async function callApiStreaming(provider, model, state, toolDefs, settings) {
    const callers = { anthropic: callAnthropic, openai: callOpenAI, google: callGoogle };
    const caller = callers[provider] || callers.anthropic;
    return caller(model, state, toolDefs, settings, true);
}

/**
 * Zoo-native Anthropic Messages client.
 * Honors ANTHROPIC_BASE_URL. Auth is Bearer (subscription / AUTH_TOKEN / sk-openzoo).
 * Never requires ANTHROPIC_API_KEY. Never POSTs to api.anthropic.com.
 */
export async function callAnthropic(model, state, toolDefs, settings, stream, deps = {}) {
    const fetchImpl = deps.fetch || globalThis.fetch;
    const env = deps.env || process.env;
    delete env.ANTHROPIC_API_KEY;

    const base = env.ANTHROPIC_BASE_URL || ZOO_LOCAL_BASE;
    const url = messagesUrl(base);
    const { headers } = anthropicHeaders(env);

    let apiModel = model;
    if (isAutoModel(model) || !model) {
        apiModel = await resolveApiModel(model, { env, fetchImpl, catalog: deps.catalog });
    }
    if (isAutoModel(apiModel) || apiModel === 'openzoo/auto') {
        apiModel = await resolveApiModel('auto', { env, fetchImpl, catalog: deps.catalog });
    }

    const body = {
        model: apiModel,
        max_tokens: settings.maxTokens || 16384,
        messages: state.messages,
        ...(state.systemPrompt && { system: state.systemPrompt }),
        ...(toolDefs.length > 0 && { tools: toolDefs }),
        ...(stream && { stream: true }),
    };

    // Thinking only if the user asked — never model.includes('opus') (zoo catalog ids).
    if (shouldEnableThinking(apiModel, { ...settings, _thinking: state._thinking }, env)) {
        body.thinking = { type: 'enabled', budget_tokens: settings.thinkingBudget || 10000 };
    }

    const wantRace = !deps._racing && (
        settings.autoRace ||
        state?._autoRace ||
        isAutoModel(model) ||
        isAutoModel(state?.model)
    );
    const bindAt = bindTokenGate(state._spillHud?.sessionMultiple?.(), { auto: wantRace });
    headers['x-openzoo-bind-tokens'] = String(bindAt);
    const dollarX = state._spillHud?.sessionMultiple?.();
    if (dollarX != null) headers['x-openzoo-dollar-x'] = String(dollarX);

    const boundMessages = bindMessagesForSend(state.messages, {
        tokenGate: bindAt,
        estimate: (m) => state._contextManager ? state._contextManager.getTokenCount(m) : Math.ceil(JSON.stringify(m || []).length / 4),
    });
    if (state?._spillHud && messagesWereBound(state.messages, boundMessages)) {
        state._spillHud.markBound();
    }

    const outbound = {
        ...body,
        messages: boundMessages,
    };

    if (wantRace) {
        const catalog = deps.catalog || state._zooCatalog || [];
        const candidates = pickRaceCandidates(catalog, settings.raceY || 3);
        if (candidates.length > 1) {
            const raced = await raceFirstX(candidates, {
                firstX: settings.raceX || 2,
                bar: settings.raceBar || 0.7,
                runOne: (m) => callAnthropic(m, state, toolDefs, { ...settings, autoRace: false, stream: false }, false, { ...deps, _racing: true, catalog }),
                classify: (replies, meta) => classifyRaceWinner(replies, {
                    ...meta,
                    catalog,
                    classifyFetch: async ({ model: clfModel, max_tokens, messages }) => {
                        return callAnthropic(
                            clfModel,
                            { messages, systemPrompt: '', _spillHud: state._spillHud },
                            [],
                            { ...settings, autoRace: false, stream: false, maxTokens: max_tokens || 64, thinking: false },
                            false,
                            { ...deps, _racing: true, catalog, _classify: true },
                        );
                    },
                }),
            });
            const picked = raced.replies.find(r => r.model === raced.winner) || raced.replies[raced.replies.length - 1];
            if (state) state.model = raced.winner;
            if (picked?.result) return picked.result;
        }
    }

    const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(outbound),
    });

    if (res.status === 402) {
        const err = await res.text();
        throw paymentErrorFromResponse(402, err);
    }

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenZoo API error ${res.status}: ${err}`);
    }

    if (state._spillHud) {
        const sent = JSON.stringify(outbound).length;
        state._spillHud.note(res.headers, sent);
    }

    if (stream) {
        const collected = [];
        const eventGenerator = async function* () {
            for await (const event of streamResponse(res)) {
                collected.push(event);
                yield event;
            }
        };
        return {
            events: eventGenerator(),
            get accumulated() {
                return accumulateFromCollected(collected);
            },
        };
    }

    return res.json();
}

async function callOpenAI(model, state, toolDefs, settings, stream) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const messages = [];
    if (state.systemPrompt) {
        messages.push({ role: 'system', content: state.systemPrompt });
    }
    for (const msg of state.messages) {
        if (typeof msg.content === 'string') {
            messages.push({ role: msg.role, content: msg.content });
        } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.type === 'tool_result') {
                    messages.push({
                        role: 'tool',
                        tool_call_id: block.tool_use_id,
                        content: block.content,
                    });
                }
            }
        }
    }

    const tools = toolDefs.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    const body = {
        model,
        messages,
        ...(tools.length > 0 && { tools }),
    };

    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return convertOpenAIResponse(data);
}

async function callGoogle(model, state, toolDefs, settings, stream) {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY not set');

    const contents = [];
    for (const msg of state.messages) {
        const role = msg.role === 'assistant' ? 'model' : 'user';
        if (typeof msg.content === 'string') {
            contents.push({ role, parts: [{ text: msg.content }] });
        }
    }

    const body = {
        contents,
        ...(state.systemPrompt && {
            systemInstruction: { parts: [{ text: state.systemPrompt }] },
        }),
    };

    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }
    );

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Google API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return convertGoogleResponse(data);
}

function convertOpenAIResponse(data) {
    const choice = data.choices?.[0];
    if (!choice) throw new Error('No choices in OpenAI response');

    const content = [];
    if (choice.message?.content) {
        content.push({ type: 'text', text: choice.message.content });
    }

    if (choice.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
            content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: JSON.parse(tc.function.arguments || '{}'),
            });
        }
    }

    return {
        content,
        stop_reason: choice.finish_reason === 'stop' ? 'end_turn' : choice.finish_reason,
        usage: {
            input_tokens: data.usage?.prompt_tokens || 0,
            output_tokens: data.usage?.completion_tokens || 0,
        },
    };
}

function convertGoogleResponse(data) {
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('No candidates in Google response');

    const content = [];
    for (const part of candidate.content?.parts || []) {
        if (part.text) content.push({ type: 'text', text: part.text });
    }

    return {
        content,
        stop_reason: 'end_turn',
        usage: {
            input_tokens: data.usageMetadata?.promptTokenCount || 0,
            output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
        },
    };
}

function accumulateFromCollected(events) {
    const message = {
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
    };

    let currentBlock = null;

    for (const event of events) {
        switch (event.type) {
            case 'message_start':
                if (event.message?.usage) {
                    message.usage.input_tokens = event.message.usage.input_tokens || 0;
                }
                break;
            case 'content_block_start':
                currentBlock = { ...event.content_block };
                if (currentBlock.type === 'text') currentBlock.text = '';
                if (currentBlock.type === 'thinking') currentBlock.thinking = '';
                if (currentBlock.type === 'tool_use') currentBlock.input = '';
                message.content.push(currentBlock);
                break;
            case 'content_block_delta':
                if (!currentBlock) break;
                if (event.delta?.type === 'text_delta') currentBlock.text += event.delta.text;
                else if (event.delta?.type === 'thinking_delta') currentBlock.thinking += event.delta.thinking;
                else if (event.delta?.type === 'input_json_delta') currentBlock.input += event.delta.partial_json;
                break;
            case 'content_block_stop':
                if (currentBlock?.type === 'tool_use' && typeof currentBlock.input === 'string') {
                    try { currentBlock.input = JSON.parse(currentBlock.input || '{}'); } catch { currentBlock.input = {}; }
                }
                currentBlock = null;
                break;
            case 'message_delta':
                if (event.delta?.stop_reason) message.stop_reason = event.delta.stop_reason;
                if (event.usage) message.usage.output_tokens = event.usage.output_tokens || 0;
                break;
            case 'ping':
                break;
        }
    }

    return message;
}
