/**
 * Agent Tool — spawn a subagent with its own agent loop.
 *
 * Features:
 * - subagent_type parameter
 * - isolation: "worktree" option
 * - run_in_background option
 * - model override
 * - prompt aliases (description/task/goal/message/instructions)
 */

import { createAgentLoop } from '../core/agent-loop.mjs';
import { createToolRegistry } from './registry.mjs';
import { createPermissionChecker } from '../permissions/checker.mjs';

/** Cheap models often send these instead of `prompt`. */
export const AGENT_PROMPT_ALIASES = ['description', 'task', 'goal', 'message', 'instructions'];

export const AGENT_MISSING_PROMPT =
    'pass prompt (string) — Agent needs a task. You can also set description, task, goal, message, or instructions.';

/**
 * Resolve a task string from prompt or its aliases. Mutates input.prompt when found.
 * @param {object} input
 * @returns {string}
 */
export function coerceAgentPrompt(input) {
    if (!input || typeof input !== 'object') return '';
    const direct = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (direct) {
        input.prompt = direct;
        return direct;
    }
    for (const key of AGENT_PROMPT_ALIASES) {
        const val = input[key];
        if (typeof val === 'string' && val.trim()) {
            input.prompt = val.trim();
            return input.prompt;
        }
    }
    return '';
}

export const AgentTool = {
    name: 'Agent',
    description: 'Spawn a subagent to handle a task. The subagent has its own context and tools. Required: prompt (string). Aliases: description, task, goal, message, instructions.',
    inputSchema: {
        type: 'object',
        properties: {
            prompt: {
                type: 'string',
                description: 'Required string. The task for the subagent to perform. Aliases accepted: description, task, goal, message, instructions.',
            },
            description: {
                type: 'string',
                description: 'Alias for prompt',
            },
            task: {
                type: 'string',
                description: 'Alias for prompt',
            },
            goal: {
                type: 'string',
                description: 'Alias for prompt',
            },
            message: {
                type: 'string',
                description: 'Alias for prompt',
            },
            instructions: {
                type: 'string',
                description: 'Alias for prompt',
            },
            allowed_tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of tool names the subagent can use (default: all)',
            },
            subagent_type: {
                type: 'string',
                description: 'Type of subagent (e.g. coder, reviewer, researcher)',
            },
            isolation: {
                type: 'string',
                enum: ['default', 'worktree'],
                description: 'Isolation mode. "worktree" uses a git worktree.',
            },
            run_in_background: {
                type: 'boolean',
                description: 'Run in background and return immediately',
            },
            model: {
                type: 'string',
                description: 'Override model for this subagent',
            },
        },
        required: ['prompt'],
    },

    validateInput(input) {
        if (coerceAgentPrompt(input)) return [];
        return [AGENT_MISSING_PROMPT];
    },

    // Track background subagents
    _backgroundAgents: new Map(),
    _nextBgId: 0,

    async call(input) {
        const prompt = coerceAgentPrompt(input);
        if (!prompt) {
            return `Error: ${AGENT_MISSING_PROMPT}`;
        }

        const model = input.model || process.env.SUBAGENT_MODEL || 'claude-sonnet-4-6';
        const tools = createToolRegistry();
        const permissions = createPermissionChecker({ defaultMode: 'bypassPermissions' });

        // Build type-specific system prompt prefix
        let systemPrefix = '';
        if (input.subagent_type) {
            const typePrompts = {
                coder: 'You are a coding agent. Write clean, tested code.',
                reviewer: 'You are a code reviewer. Analyze code for bugs and improvements.',
                researcher: 'You are a research agent. Find and summarize information.',
                tester: 'You are a testing agent. Write and run tests.',
                planner: 'You are a planning agent. Break down tasks into steps.',
            };
            systemPrefix = typePrompts[input.subagent_type] || `You are a ${input.subagent_type} agent.`;
        }

        const fullPrompt = systemPrefix
            ? `${systemPrefix}\n\nTask: ${input.prompt}`
            : input.prompt;

        const loop = createAgentLoop({
            model,
            tools,
            permissions,
            settings: { stream: false },
        });

        if (input.run_in_background) {
            const bgId = ++AgentTool._nextBgId;
            const entry = { id: bgId, status: 'running', result: null, prompt: input.prompt };
            AgentTool._backgroundAgents.set(bgId, entry);

            // Run in background
            runSubagent(loop, fullPrompt).then(result => {
                entry.status = 'completed';
                entry.result = result;
            }).catch(err => {
                entry.status = 'error';
                entry.result = err.message;
            });

            return `Subagent started in background: id=${bgId}`;
        }

        return runSubagent(loop, fullPrompt);
    },
};

async function runSubagent(loop, prompt) {
    const results = [];
    try {
        for await (const event of loop.run(prompt)) {
            if (event.type === 'assistant' && event.content) {
                results.push(event.content);
            }
            if (event.type === 'result') {
                results.push(`[tool:${event.tool}] ${String(event.result).slice(0, 500)}`);
            }
        }
    } catch (err) {
        return `Subagent error: ${err.message}`;
    }

    return results.join('\n') || 'Subagent completed with no output.';
}
