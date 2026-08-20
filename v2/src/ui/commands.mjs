/**
 * Slash Commands — all 39 commands from Claude Code.
 *
 * Each command is a function(args, state) that returns a string response.
 * Commands are invoked via /command-name in the REPL.
 */

import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { SessionManager } from '../core/session.mjs';
import { CheckpointManager } from '../core/checkpoints.mjs';
import { PromptCache } from '../core/cache.mjs';
import { readEnv, listEnvVars } from '../config/env.mjs';
import * as telemetry from '../telemetry/index.mjs';
import { OutcomeStore } from '../optimize/store.mjs';
import { cronStore } from '../tools/cron-create.mjs';
import {
    BILLING_ORIGIN,
    clearSubscription,
    isAutoModel,
    parseSubscriptionPaste,
    saveSubscription,
    subscriptionPublicView,
} from '../core/openzoo.mjs';

const checkpoints = new CheckpointManager();
const promptCache = new PromptCache();
let sessionManager = null;

function getSession() {
    if (!sessionManager) sessionManager = new SessionManager();
    return sessionManager;
}

/**
 * All slash commands.
 */
export const COMMANDS = {
    '/help': {
        description: 'Show available commands',
        handler(args, state) {
            const lines = ['', 'Available commands:'];
            for (const [name, cmd] of Object.entries(COMMANDS)) {
                lines.push(`  ${name.padEnd(20)} ${cmd.description}`);
            }
            lines.push('');
            return lines.join('\n');
        },
    },

    '/clear': {
        description: 'Clear conversation history',
        handler(args, state) {
            state.messages.length = 0;
            state.turnCount = 0;
            state.tokenUsage = { input: 0, output: 0 };
            if (state._repeatGuard) {
                state._repeatGuard._log?.clear?.();
                state._repeatGuard._artifacts?.clear?.();
            }
            if (state._spillHud) {
                state._spillHud.calls = 0;
                state._spillHud.spilledCalls = 0;
                state._spillHud.corpusChars = 0;
                state._spillHud.sentChars = 0;
                state._spillHud.lastMultiple = null;
            }
            if (state._sessionManager?.newChat) {
                state._sessionManager.newChat();
                state._sessionManager.save(state);
            }
            return 'New chat isolated from prior thread/tool context.';
        },
    },

    '/compact': {
        description: 'Manually compact conversation context',
        handler(args, state) {
            const before = state.messages.length;
            const beforeTokens = state._contextManager
                ? state._contextManager.getTokenCount(state.messages)
                : 0;

            if (state._contextManager) {
                state.messages = state._contextManager.compact(state.messages);
            } else {
                if (state.messages.length > 10) {
                    state.messages = state.messages.slice(-8);
                }
            }

            const afterTokens = state._contextManager
                ? state._contextManager.getTokenCount(state.messages)
                : 0;

            return `Compacted: ${before} -> ${state.messages.length} messages` +
                (beforeTokens ? ` (~${beforeTokens} -> ~${afterTokens} tokens)` : '');
        },
    },

    '/cost': {
        description: 'Show token usage and estimated cost',
        handler(args, state) {
            const { input, output } = state.tokenUsage;
            const hud = state._spillHud?.format?.() || '';
            return [
                `Token usage: input=${input}, output=${output}`,
                hud ? `Spill HUD: ${hud}` : 'Spill HUD: (no bind yet)',
                `Model: ${state.model || 'default'}`,
                `Turns: ${state.turnCount}`,
            ].join('\n');
        },
    },

    '/doctor': {
        description: 'Check system health and configuration',
        handler(args, state) {
            const checks = [];
            checks.push(`Node.js: ${process.version}`);
            checks.push(`openzoo-claude: 2.0.0`);
            checks.push(`ANTHROPIC_BASE_URL: ${process.env.ANTHROPIC_BASE_URL || 'http://localhost:8402/v1'}`);
            checks.push(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'SET (unset this — it bills api.anthropic.com)' : 'unset (good)'}`);
            checks.push(`ANTHROPIC_AUTH_TOKEN: ${process.env.ANTHROPIC_AUTH_TOKEN ? 'set' : 'NOT SET'}`);
            checks.push(`Model: ${state.model || 'default'}`);
            checks.push(`Tools: ${state.tools?.list?.()?.length || 0}`);
            checks.push(`Messages: ${state.messages.length}`);
            checks.push(`CWD: ${process.cwd()}`);
            checks.push(`Platform: ${process.platform}`);

            let apiStatus = 'OpenZoo sidecar / subscription Bearer';
            checks.push(`API: ${apiStatus}`);

            // Check MCP servers
            const mcpCount = state._mcpClients?.length || 0;
            checks.push(`MCP servers: ${mcpCount}`);

            return `System check:\n${checks.map(c => `  ${c}`).join('\n')}`;
        },
    },

    '/fast': {
        description: 'Toggle fast mode (uses faster, cheaper model)',
        handler(args, state) {
            const catalog = state?._zooCatalog || [];
            const cheap = catalog.find(m => /haiku|mini|flash|lightning|small|nano/i.test(m) && !/opus/i.test(m));
            const normal = catalog.find(m => /sonnet|fable/i.test(m) && !/opus/i.test(m)) || catalog[0];
            if (state.model && /haiku|mini|flash|lightning|small|nano/i.test(state.model)) {
                state.model = normal || 'openzoo-claude-sonnet';
                state._autoRace = false;
                if (state._settings) state._settings.autoRace = false;
                return `Fast mode OFF — using ${state.model}`;
            }
            state.model = cheap || 'openzoo-haiku';
            state._autoRace = false;
            if (state._settings) state._settings.autoRace = false;
            return `Fast mode ON — using ${state.model} (haiku-class)`;
        },
    },

    '/model': {
        description: 'Show or switch model (zoo catalog)',
        handler(args, state) {
            const catalog = state?._zooCatalog || [];
            if (args && args !== 'list') {
                const id = String(args).trim();
                if (isAutoModel(id)) {
                    state.model = 'auto';
                    state._autoRace = true;
                    if (state._settings) state._settings.autoRace = true;
                    return 'Auto: cheap race (first X of Y). Never sending openzoo/auto.';
                }
                state.model = id;
                state._autoRace = false;
                if (state._settings) state._settings.autoRace = false;
                return `Model switched to: ${id}`;
            }
            const race = state._autoRace || state._settings?.autoRace ? ' (cheap race)' : '';
            const lines = [`Current model: ${state.model || 'default'}${race}`];
            if (catalog.length) {
                lines.push(`Zoo catalog (${catalog.length}):`);
                for (const id of catalog.slice(0, 80)) lines.push(`  ${id}`);
                if (catalog.length > 80) lines.push(`  … ${catalog.length - 80} more`);
            } else {
                lines.push('Zoo catalog unavailable (is :8402 up?). Catalog loads at boot from GET /v1/models.');
            }
            return lines.join('\n');
        },
    },

    '/tokens': {
        description: 'Show token usage and context size',
        handler(args, state) {
            const contextTokens = state._contextManager
                ? state._contextManager.getTokenCount(state.messages)
                : '?';
            return [
                `Input: ${state.tokenUsage.input}, Output: ${state.tokenUsage.output}`,
                `Messages: ${state.messages.length}`,
                `Context: ~${contextTokens} tokens`,
            ].join('\n');
        },
    },

    '/tools': {
        description: 'List available tools',
        handler(args, state) {
            const tools = state.tools?.list?.() || [];
            if (tools.length === 0) return 'No tools registered.';
            const lines = tools.map(t => `  ${t.name.padEnd(20)} ${(t.description || '').slice(0, 55)}`);
            return `Tools (${tools.length}):\n${lines.join('\n')}`;
        },
    },

    '/quit': {
        description: 'Exit the REPL',
        handler() { return 'EXIT'; },
    },

    '/exit': {
        description: 'Exit the REPL',
        handler() { return 'EXIT'; },
    },

    '/bug': {
        description: 'Report a bug',
        handler() {
            return 'Report bugs at: https://github.com/staccDOTsol/open-claude-code/issues';
        },
    },

    '/review': {
        description: 'Review recent changes',
        handler(args, state) {
            try {
                const diff = execSync('git diff --stat HEAD~1 2>/dev/null || echo "No git history"', { encoding: 'utf-8' });
                return `Recent changes:\n${diff}`;
            } catch {
                return 'Unable to review changes (not in a git repo or no history).';
            }
        },
    },

    '/init': {
        description: 'Initialize Claude Code in current directory',
        handler() {
            const claudeDir = path.join(process.cwd(), '.claude');
            fs.mkdirSync(claudeDir, { recursive: true });
            const settingsFile = path.join(claudeDir, 'settings.json');
            if (!fs.existsSync(settingsFile)) {
                fs.writeFileSync(settingsFile, JSON.stringify({ permissions: {}, hooks: {} }, null, 2));
            }
            return `Initialized .claude/ in ${process.cwd()}`;
        },
    },

    '/login': {
        description: 'Save OpenZoo subscription key (never ANTHROPIC_API_KEY)',
        handler(args) {
            delete process.env.ANTHROPIC_API_KEY;
            if (!args) {
                return `Usage: /login <subscription-key>\nGet a key at ${BILLING_ORIGIN} — never paste an Anthropic API key.`;
            }
            const parsed = parseSubscriptionPaste(args);
            if (parsed.session) {
                return `That looks like a checkout session, not the key. Open ${BILLING_ORIGIN} and paste the subscription key.`;
            }
            if (parsed.error || !parsed.key) {
                return `Not a subscription key. Paste the key from ${BILLING_ORIGIN}.`;
            }
            saveSubscription({ key: parsed.key });
            process.env.ANTHROPIC_AUTH_TOKEN = parsed.key;
            process.env.OPENZOO_SUBSCRIPTION_KEY = parsed.key;
            delete process.env.ANTHROPIC_API_KEY;
            const view = subscriptionPublicView();
            return view.label
                ? `Subscription saved (${view.label}). ANTHROPIC_API_KEY stays unset.`
                : 'Subscription saved. ANTHROPIC_API_KEY stays unset.';
        },
    },

    '/logout': {
        description: 'Clear OpenZoo subscription (API key stays unset)',
        handler() {
            clearSubscription();
            delete process.env.ANTHROPIC_AUTH_TOKEN;
            delete process.env.OPENZOO_SUBSCRIPTION_KEY;
            delete process.env.ANTHROPIC_API_KEY;
            return 'Subscription cleared. ANTHROPIC_API_KEY stays unset.';
        },
    },

    '/status': {
        description: 'Show session status',
        handler(args, state) {
            const session = getSession();
            const info = session.info();
            return [
                `Session: ${info.id}`,
                `Project: ${info.projectDir}`,
                `Started: ${info.startedAt}`,
                `Model: ${state.model}`,
                `Turns: ${state.turnCount}`,
                `Messages: ${state.messages.length}`,
            ].join('\n');
        },
    },

    '/config': {
        description: 'Show current configuration',
        handler(args, state) {
            const env = readEnv();
            const lines = ['Configuration:'];
            for (const [key, val] of Object.entries(env)) {
                if (key.includes('KEY') || key.includes('TOKEN')) continue;
                lines.push(`  ${key}: ${val}`);
            }
            return lines.join('\n');
        },
    },

    '/memory': {
        description: 'Show conversation memory usage',
        handler(args, state) {
            const msgSize = JSON.stringify(state.messages).length;
            const tokenEst = state._contextManager
                ? state._contextManager.getTokenCount(state.messages)
                : Math.ceil(msgSize / 4);
            return `Memory: ${state.messages.length} messages, ~${(msgSize / 1024).toFixed(1)}KB, ~${tokenEst} tokens`;
        },
    },

    '/forget': {
        description: 'Remove last N messages',
        handler(args, state) {
            const n = parseInt(args) || 2;
            const removed = state.messages.splice(-n, n);
            return `Removed ${removed.length} messages.`;
        },
    },

    '/effort': {
        description: 'Set effort level (low/normal/high)',
        handler(args, state) {
            const levels = ['low', 'normal', 'high'];
            if (args && levels.includes(args)) {
                state._effortLevel = args;
                return `Effort level set to: ${args}`;
            }
            return `Current effort: ${state._effortLevel || 'normal'}. Options: low, normal, high`;
        },
    },

    '/think': {
        description: 'Toggle extended thinking',
        handler(args, state) {
            state._thinking = !state._thinking;
            state._showThinking = state._thinking;
            if (state._showThinking) process.env.SHOW_THINKING = '1';
            else delete process.env.SHOW_THINKING;
            return `Thinking ${state._thinking ? 'ON (expanded)' : 'OFF (folded)'}`;
        },
    },

    '/plan': {
        description: 'Enter plan mode (read-only)',
        handler(args, state) {
            state._planMode = !state._planMode;
            return `Plan mode: ${state._planMode ? 'ON (read-only)' : 'OFF'}`;
        },
    },

    '/vim': {
        description: 'Toggle vim keybindings',
        handler(args, state) {
            state._vimMode = !state._vimMode;
            return `Vim mode: ${state._vimMode ? 'ON' : 'OFF'}`;
        },
    },

    '/terminal-setup': {
        description: 'Show terminal setup info',
        handler() {
            return [
                'Terminal setup:',
                `  TERM: ${process.env.TERM || 'unknown'}`,
                `  COLUMNS: ${process.stdout.columns || 'unknown'}`,
                `  ROWS: ${process.stdout.rows || 'unknown'}`,
                `  Color: ${process.stdout.hasColors?.() ? 'yes' : 'unknown'}`,
                `  Unicode: ${process.env.LANG?.includes('UTF') ? 'yes' : 'unknown'}`,
            ].join('\n');
        },
    },

    '/mcp': {
        description: 'Show MCP server status',
        handler(args, state) {
            if (!state._mcpClients || state._mcpClients.length === 0) {
                return 'No MCP servers connected.';
            }
            const lines = state._mcpClients.map((c, i) =>
                `  ${i + 1}. ${c.config?.command || 'unknown'} — ${c.connected ? 'connected' : 'disconnected'}`
            );
            return `MCP servers:\n${lines.join('\n')}`;
        },
    },

    '/permissions': {
        description: 'Show permission mode',
        handler(args, state) {
            return `Permission mode: ${state._permissionMode || 'default'}`;
        },
    },

    '/hooks': {
        description: 'Show configured hooks',
        handler(args, state) {
            if (!state._hooks) return 'No hooks configured.';
            const hooks = state._hooks;
            const lines = [];
            for (const [event, handlers] of Object.entries(hooks)) {
                const arr = Array.isArray(handlers) ? handlers : [handlers];
                lines.push(`  ${event}: ${arr.length} handler(s)`);
            }
            return lines.length > 0 ? `Hooks:\n${lines.join('\n')}` : 'No hooks configured.';
        },
    },

    '/agents': {
        description: 'List custom agents',
        handler(args, state) {
            if (!state._agentLoader) return 'No agent loader initialized.';
            const agents = state._agentLoader.list();
            if (agents.length === 0) return 'No custom agents loaded.';
            return `Agents:\n${agents.map(a => `  ${a.name}: ${a.description}`).join('\n')}`;
        },
    },

    '/skills': {
        description: 'List available skills',
        handler(args, state) {
            if (!state._skillsLoader) return 'No skills loaded.';
            const skills = state._skillsLoader.list();
            if (skills.length === 0) return 'No skills loaded.';
            return `Skills:\n${skills.map(s => `  /${s.name}: ${s.description}`).join('\n')}`;
        },
    },

    '/schedule': {
        description: 'List scheduled tasks',
        handler() {
            if (!cronStore || cronStore.size === 0) return 'No scheduled tasks.';
            const lines = [];
            for (const [, job] of cronStore) {
                lines.push(`  ${job.id}: ${job.name} (${job.schedule})`);
            }
            return `Scheduled:\n${lines.join('\n')}`;
        },
    },

    '/extra-usage': {
        description: 'Show detailed usage stats',
        handler(args, state) {
            const cacheStats = promptCache.getStats();
            const telemetryStats = telemetry.getStats();
            return [
                `Tokens: in=${state.tokenUsage.input}, out=${state.tokenUsage.output}`,
                `Cache: hits=${cacheStats.cacheHits}, misses=${cacheStats.cacheMisses}, rate=${cacheStats.hitRate}`,
                `Telemetry: ${telemetryStats.totalEvents} events`,
            ].join('\n');
        },
    },

    '/undo': {
        description: 'Undo last file edit (restore checkpoint)',
        handler() {
            const result = checkpoints.undo();
            if (!result) return 'No checkpoints to undo.';
            if (result.restored) return `Restored: ${result.filePath}`;
            return `Undo failed: ${result.error || 'unknown error'}`;
        },
    },

    '/diff': {
        description: 'Show git diff',
        handler() {
            try {
                return execSync('git diff --stat 2>/dev/null || echo "Not in a git repo"', { encoding: 'utf-8' });
            } catch {
                return 'Unable to show diff.';
            }
        },
    },

    '/listen': {
        description: 'Toggle listening mode (voice input stub)',
        handler(args, state) {
            state._listening = !state._listening;
            return `Listening mode: ${state._listening ? 'ON (stub)' : 'OFF'}`;
        },
    },

    '/commit': {
        description: 'Create a git commit with AI message',
        handler(args) {
            try {
                // Security: use execFileSync with discrete args so the commit
                // message is never shell-interpolated (prevents injection via
                // crafted message strings containing shell metacharacters).
                const msg = args || 'Update from openzoo-claude';
                execFileSync('git', ['add', '-A'], { encoding: 'utf-8' });
                execFileSync('git', ['commit', '-m', msg], { encoding: 'utf-8' });
                return `Committed: ${msg}`;
            } catch (err) {
                return `Commit failed: ${err.message}`;
            }
        },
    },

    '/pr': {
        description: 'Create a pull request (stub)',
        handler() {
            return 'PR creation requires gh CLI. Run: gh pr create --fill';
        },
    },

    '/release': {
        description: 'Create a release (stub)',
        handler() {
            return 'Release creation requires gh CLI. Run: gh release create <tag>';
        },
    },

    '/optimize': {
        description: 'Self-optimization router status / report (metaharness)',
        handler(args, state) {
            const sub = (args || '').trim().split(/\s+/)[0] || 'status';
            const store = new OutcomeStore();
            if (sub === 'report') {
                const summary = store.summary();
                if (summary.total === 0) return 'No recorded outcomes yet. Start occ with --self-optimize to collect real data.';
                const lines = [`Optimization report — ${summary.total} outcomes`];
                for (const [m, b] of Object.entries(summary.byModel)) {
                    lines.push(`  ${m}: ${b.attempts} runs, ${(b.successRate * 100).toFixed(0)}% ok, ~$${b.costUsd.toFixed(4)}`);
                }
                lines.push(`  total est cost: $${summary.totalCostUsd.toFixed(4)}`);
                return lines.join('\n');
            }
            if (sub === 'reset') {
                return store.reset() ? 'Outcome store cleared.' : 'Nothing to reset.';
            }
            // status (default)
            const enabled = !!(state && state._cascade);
            const summary = store.summary();
            return [
                'MetaHarness self-optimization',
                `  live router this session: ${enabled ? 'ON' : 'OFF (start with --self-optimize)'}`,
                `  recorded outcomes:        ${summary.total}`,
                `  store:                    ${store.filePath}`,
            ].join('\n');
        },
    },
};

/**
 * Execute a slash command.
 * @param {string} input - full command string (e.g., "/model claude-sonnet-4-6")
 * @param {object} state - agent loop state
 * @returns {{ response: string, exit: boolean }}
 */
export function executeCommand(input, state) {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    const command = COMMANDS[cmd];
    if (!command) {
        return { response: `Unknown command: ${cmd}. Type /help for available commands.`, exit: false };
    }

    const response = command.handler(args, state);
    return { response, exit: response === 'EXIT' };
}

/**
 * Get command completions for tab-complete.
 * @param {string} partial
 * @returns {string[]}
 */
export function getCompletions(partial) {
    return Object.keys(COMMANDS).filter(c => c.startsWith(partial));
}
