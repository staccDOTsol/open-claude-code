/**
 * Savings lessons learned on grokui/openzoo — encoded in this CLI, not a wrapper.
 *
 * No RUN:/WRITE:/SPAWN: text harness. Claude Code tools are the interpreter.
 */

import path from 'path';

export const HARNESS_PREFIX = /^(?:RUN|WRITE|SPAWN|READ|EDIT|GLOB|GREP|MULTIEDIT|DONE|NUDGE|AUTO_DIRECTIVE|AUTO_CONTINUE)\s*:/i;
export const HARNESS_INJECT = /\b(?:NUDGE|AUTO_DIRECTIVE|AUTO_CONTINUE|emit\s+RUN:\/WRITE:\/SPAWN:)\b/i;
export const PACKAGE_MANAGERS = /\b(?:brew|npm|pnpm|yarn|bun)\b/;

export function isHarnessCommand(command) {
    return HARNESS_PREFIX.test(String(command || '').trim());
}

export function isHarnessUserText(text) {
    return HARNESS_INJECT.test(String(text || ''));
}

/**
 * Never execute a model string that looks like `WRITE:file` as bash.
 */
export function rejectHarnessBash(command) {
    const cmd = String(command || '').trim();
    if (!isHarnessCommand(cmd)) return null;
    return 'Error: WRITE:/RUN:/SPAWN: text is not a bash command. Use the Write/Bash/Edit tools.';
}

/**
 * cwd-aware find: rewrite `find /` and finds outside the thread/workdir
 * to `find . -maxdepth 8`.
 */
export function rewriteFindCommand(command, cwd = process.cwd()) {
    const cmd = String(command || '');
    if (!/\bfind\b/.test(cmd)) return cmd;
    const root = path.resolve(cwd);

    return cmd.replace(/\bfind(\s+)(--\s+)?(\S+)/g, (all, ws, dash, target) => {
        if (!target || target.startsWith('-')) return all;
        const cleaned = target.replace(/^['"]|['"]$/g, '');
        if (cleaned === '.' || cleaned === './' || cleaned.startsWith('./')) {
            if (/\s-maxdepth\s/.test(cmd)) return all;
            return `find${ws}${dash || ''}. -maxdepth 8`;
        }
        let resolved;
        try {
            resolved = path.resolve(root, cleaned);
        } catch {
            return `find${ws}${dash || ''}. -maxdepth 8`;
        }
        const inside = resolved === root || resolved.startsWith(root + path.sep);
        if (cleaned === '/' || cleaned === '/*' || !inside) {
            return `find${ws}${dash || ''}. -maxdepth 8`;
        }
        if (/\s-maxdepth\s/.test(cmd)) return all;
        return `find${ws}${dash || ''}${target} -maxdepth 8`;
    });
}

/**
 * Cap identical Bash/Grep. Do not redo a command after it succeeded or
 * after a hard fail. If a compile already produced the artifact, stop grepping.
 */
export class ToolRepeatGuard {
    constructor({ maxIdentical = 2 } = {}) {
        this.maxIdentical = maxIdentical;
        this._log = new Map();
        this._artifacts = new Set();
    }

    key(name, input) {
        if (name === 'Bash') return `Bash:${String(input?.command || '').trim()}`;
        if (name === 'Grep') return `Grep:${String(input?.pattern || '')}|${input?.path || ''}`;
        return `${name}:${JSON.stringify(input || {})}`;
    }

    check(name, input) {
        if (name !== 'Bash' && name !== 'Grep' && name !== 'Agent') return { skip: false };
        const k = this.key(name, input);
        const prev = this._log.get(k);
        if (!prev) return { skip: false };

        if (prev.ok) {
            return {
                skip: true,
                message: `Skipped repeat ${name} — already succeeded.\n${prev.result || ''}`.trim(),
            };
        }
        // Agent missing-prompt (or any hard fail): one error, then skip. Do not loop.
        if (name === 'Agent') {
            return {
                skip: true,
                message: `Skipped repeat Agent — identical call already failed. Pass prompt (string).`,
            };
        }
        if (prev.count >= this.maxIdentical) {
            return {
                skip: true,
                message: `Skipped repeat ${name} — identical call failed ${prev.count} times.`,
            };
        }
        if (name === 'Grep' && this._artifacts.size > 0 && /compile|build|tsc|cargo/.test(k) === false) {
            // compile already produced an artifact — do not grep forever
            return {
                skip: true,
                message: `Skipped repeat Grep — build artifact already present (${[...this._artifacts].slice(0, 3).join(', ')}).`,
            };
        }
        return { skip: false };
    }

    record(name, input, result) {
        const k = this.key(name, input);
        const prev = this._log.get(k) || { count: 0, ok: false, result: '' };
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        const hardFail = /^(Error:|Exit code: [1-9]|Validation error:)/m.test(text);
        const ok = !hardFail;
        this._log.set(k, { count: prev.count + 1, ok, result: text });
        if (name === 'Bash' && ok) {
            const wrote = /\b(?:wrote|created|emitting|dist\/|build\/)\b/i.test(text);
            if (wrote) this._artifacts.add((input?.command || '').slice(0, 40));
        }
        return { ok, count: prev.count + 1 };
    }
}

export function looksLikeToolJsonDump(text) {
    const t = String(text || '').trim();
    if (!t.startsWith('{') || !t.endsWith('}')) return false;
    try {
        const j = JSON.parse(t);
        if (!j || typeof j !== 'object') return false;
        return Boolean(
            j.tool_use || j.tool_result || j.type === 'tool_use' || j.type === 'tool_result' ||
            (j.file_path && (j.content != null || j.old_string != null)) ||
            j.currentDir || j['system-reminder']
        );
    } catch {
        return false;
    }
}

/** Canvas/REPL: tools run; the model speaks. Do not dump raw tool JSON. */
export function sanitizeAssistantCanvas(text) {
    if (text == null) return '';
    const s = String(text);
    if (looksLikeToolJsonDump(s)) return '';
    return s.replace(/^(?:RUN|WRITE|SPAWN|READ|EDIT|GLOB|GREP|MULTIEDIT):\s*.*$/gim, '').trim();
}

/**
 * Persist the user message to the session store BEFORE any API call.
 * Refresh must not forget the turn.
 */
export function persistUserTurn(sessionManager, state) {
    if (!sessionManager || typeof sessionManager.save !== 'function') return null;
    return sessionManager.save(state);
}
