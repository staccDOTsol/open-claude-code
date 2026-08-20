/**
 * Official Claude Code `--output-format stream-json` NDJSON.
 *
 * grokui foldClaudeEvent expects this shape (system/init, assistant+message,
 * result subtype success) — not occ's internal events.
 */

import crypto from 'crypto';

export function newSessionId() {
    return crypto.randomUUID?.() || `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export function emitNdjson(obj) {
    return JSON.stringify(obj);
}

export function systemInit({
    sessionId,
    model,
    tools = [],
    cwd = process.cwd(),
    permissionMode = 'bypassPermissions',
} = {}) {
    const names = (tools || []).map(t => (typeof t === 'string' ? t : t.name)).filter(Boolean);
    return {
        type: 'system',
        subtype: 'init',
        cwd,
        session_id: sessionId,
        tools: names,
        mcp_servers: [],
        model,
        permissionMode,
        slash_commands: [],
        apiKeySource: 'none',
        claude_code_version: '2.0.0',
    };
}

export function assistantMessage({
    sessionId,
    model,
    content,
    usage,
    stopReason = null,
    id,
} = {}) {
    const blocks = Array.isArray(content)
        ? content
        : (content ? [{ type: 'text', text: String(content) }] : []);
    return {
        type: 'assistant',
        message: {
            id: id || `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model,
            content: blocks,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: usage || { input_tokens: 0, output_tokens: 0 },
        },
        session_id: sessionId,
    };
}

export function streamEventWrap(event, sessionId) {
    return {
        type: 'stream_event',
        event,
        session_id: sessionId,
    };
}

export function userToolResult({ sessionId, toolResults } = {}) {
    return {
        type: 'user',
        message: {
            role: 'user',
            content: toolResults,
        },
        session_id: sessionId,
    };
}

export function resultSuccess({
    sessionId,
    result,
    usage,
    durationMs,
    numTurns,
    isError = false,
} = {}) {
    return {
        type: 'result',
        subtype: isError ? 'error' : 'success',
        is_error: Boolean(isError),
        result: result == null ? '' : String(result),
        session_id: sessionId,
        usage: usage || { input_tokens: 0, output_tokens: 0 },
        duration_ms: durationMs || 0,
        num_turns: numTurns || 1,
    };
}
