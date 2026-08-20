#!/usr/bin/env node
/**
 * openzoo-claude — OpenZoo Claude Code CLI
 *
 * Pay-per-call via the local OpenZoo sidecar (:8402). Subscription Bearer
 * or x402. Never ANTHROPIC_API_KEY. Never api.anthropic.com.
 *
 * Also works under ELECTRON_RUN_AS_NODE=1 + Electron execPath + this .mjs
 * (Finder-launched grokui has no nvm `node` on PATH).
 */

import { createAgentLoop } from './core/agent-loop.mjs';
import { createToolRegistry } from './tools/registry.mjs';
import { createPermissionChecker } from './permissions/checker.mjs';
import { loadSettings } from './config/settings.mjs';
import { parseArgs, getUsageText } from './config/cli-args.mjs';
import { HookEngine } from './hooks/engine.mjs';
import { McpClient } from './mcp/client.mjs';
import { AgentLoader } from './agents/loader.mjs';
import { SkillsLoader } from './skills/loader.mjs';
import { SessionManager } from './core/session.mjs';
import { CheckpointManager } from './core/checkpoints.mjs';
import { PromptCache } from './core/cache.mjs';
import { readEnv } from './config/env.mjs';
import * as telemetry from './telemetry/index.mjs';
import {
    detectAndApplyZooEnv,
    fetchZooModels,
    isAutoModel,
    resolveApiModel,
} from './core/openzoo.mjs';
import { sanitizeAssistantCanvas } from './core/savings.mjs';
import {
    assistantMessage,
    emitNdjson,
    newSessionId,
    resultSuccess,
    streamEventWrap,
    systemInit,
    userToolResult,
} from './core/stream-json.mjs';

async function main() {
    const rawArgv = process.argv.slice(2);

    // ── Metaharness subcommand dispatch (opt-in; runs before normal flow) ──
    // `occ optimize|redblue|darwin ...` are handled here and exit. A normal
    // `occ "prompt"` never reaches this branch, so default behavior is intact.
    const subcommand = rawArgv[0];
    if (subcommand === 'optimize' || subcommand === 'redblue' || subcommand === 'darwin') {
        const settings = await loadSettings();
        const { runOptimize, delegateToCli } = await import('./optimize/commands.mjs');
        if (subcommand === 'optimize') {
            const { output, code } = await runOptimize(rawArgv.slice(1), settings);
            console.log(output);
            process.exit(code);
        }
        const pkg = subcommand === 'redblue' ? '@metaharness/redblue' : '@metaharness/darwin';
        const { code } = await delegateToCli(pkg, rawArgv.slice(1));
        process.exit(code);
    }

    // Apply zoo env when :8402 /v1/info answers so `claude`/`occ` work
    // without the openzoo wrapper. Payment is not a boot gate.
    const zoo = await detectAndApplyZooEnv(process.env);
    delete process.env.ANTHROPIC_API_KEY;

    const args = parseArgs(rawArgv);

    // Handle --version
    if (args.showVersion) {
        console.log('openzoo-claude 2.0.0');
        process.exit(0);
    }

    // Handle --help
    if (args.showHelp) {
        console.log(getUsageText());
        process.exit(0);
    }

    const settings = await loadSettings();
    const env = readEnv();

    // Apply CLI overrides to settings
    if (args.permissionMode) settings.permissions = { ...settings.permissions, defaultMode: args.permissionMode };
    else if (zoo.zoo && !args.permissionMode) {
        settings.permissions = { ...settings.permissions, defaultMode: process.env.CLAUDE_CODE_PERMISSION_MODE || 'bypassPermissions' };
    }
    if (args.systemPrompt) settings.systemPromptOverride = args.systemPrompt;
    if (args.addDirs?.length) settings.addDirs = args.addDirs;
    if (args.maxTurns) settings.maxTurns = args.maxTurns;
    if (args.verbose) settings.verbose = true;
    if (args.debug) settings.debug = true;

    if (args.print && !args.prompt && !process.stdin.isTTY) {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        args.prompt = Buffer.concat(chunks).toString('utf8').trim() || args.prompt;
    }

    const tools = createToolRegistry();
    const permissions = createPermissionChecker(settings.permissions);
    const hooks = new HookEngine(settings.hooks);

    // Apply tool allow/deny lists
    if (args.allowedTools) settings.allowedTools = args.allowedTools;
    if (args.disallowedTools) settings.disallowedTools = args.disallowedTools;

    // Load custom agents
    const agentLoader = new AgentLoader();
    agentLoader.load();

    // Load skills
    const skillsLoader = new SkillsLoader();
    skillsLoader.load();

    // Wire skill tool
    const skillTool = tools.get('Skill');
    if (skillTool) skillTool._skillsLoader = skillsLoader;

    // Session management
    const sessionManager = new SessionManager();
    const checkpointManager = new CheckpointManager();
    const promptCache = new PromptCache();

    // Connect MCP servers if configured
    const mcpClients = [];
    if (settings.mcpServers) {
        for (const [name, config] of Object.entries(settings.mcpServers)) {
            try {
                const client = new McpClient(config);
                await client.connect();
                const mcpTools = await client.listTools();
                tools.registerMcpTools(mcpTools, (toolName, toolArgs) => client.callTool(toolName, toolArgs));
                mcpClients.push(client);
            } catch (err) {
                console.error(`MCP server "${name}" failed to connect: ${err.message}`);
            }
        }
    }

    // Wire MCP resource tool
    const mcpResourceTool = tools.get('ReadMcpResource');
    if (mcpResourceTool) mcpResourceTool._mcpClients = mcpClients;

    // ── Opt-in self-optimization cascade ──
    // Only constructed when enabled (flag > env > setting). When null, the agent
    // loop behaves exactly as before — same model, no outcome recording.
    let cascade = null;
    const { isSelfOptimizeEnabled } = await import('./optimize/cascade.mjs');
    if (isSelfOptimizeEnabled(args, settings, process.env)) {
        const { SelfOptimizeCascade } = await import('./optimize/cascade.mjs');
        cascade = new SelfOptimizeCascade({
            settings,
            fallbackModel: args.model || settings.model || 'claude-sonnet-4-6',
        });
        if (args.verbose || settings.verbose) {
            console.error('\x1b[2m[self-optimize] cost-cascade router enabled\x1b[0m');
        }
    }

    // Auto is the OpenZoo classifier. Ignore ~/.claude model pins (grok 4.6, sonnet-5).
    // Only an explicit -m/--model flag leaves Auto.
    let model = args.model || 'openzoo/auto';
    const catalog = await fetchZooModels();
    if (!args.model || isAutoModel(model)) model = 'openzoo/auto';

    const loop = createAgentLoop({
        model,
        tools,
        permissions,
        settings,
        hooks,
        cascade,
        sessionManager,
    });

    // Attach extra state for commands to access
    loop.state._agentLoader = agentLoader;
    loop.state._skillsLoader = skillsLoader;
    loop.state._mcpClients = mcpClients;
    loop.state._hooks = settings.hooks;
    loop.state._permissionMode = settings.permissions?.defaultMode || 'default';
    loop.state._sessionManager = sessionManager;
    loop.state._checkpointManager = checkpointManager;
    loop.state._promptCache = promptCache;
    loop.state._zooCatalog = catalog;

    telemetry.track('session.start', { model: loop.state.model });

    // Graceful shutdown
    const cleanup = async () => {
        telemetry.track('session.end', {
            turns: loop.state.turnCount,
            tokens: loop.state.tokenUsage,
        });
        for (const client of mcpClients) {
            await client.disconnect().catch(() => {});
        }
    };
    process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
    process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });

    if (args.prompt || args.print) {
        // Non-interactive: run prompt and exit (no Ink — plain stdout)
        const outputFormat = args.outputFormat || 'text';
        const results = [];
        const sessionId = sessionManager.sessionId || newSessionId();
        const started = Date.now();
        if (outputFormat === 'stream-json') {
            console.log(emitNdjson(systemInit({
                sessionId,
                model: loop.state.model,
                tools: tools.list(),
                permissionMode: loop.state._permissionMode,
            })));
        }

        const assistantBits = [];
        for await (const event of loop.run(args.prompt || '')) {
            results.push(event);
            if (outputFormat === 'stream-json') {
                writeOfficialStreamJson(event, {
                    sessionId,
                    model: loop.state.model,
                    assistantBits,
                });
            } else if (outputFormat !== 'json') {
                handleEvent(event, settings);
            }
        }

        if (outputFormat === 'json') {
            const texts = results
                .filter(e => e.type === 'assistant')
                .map(e => e.content)
                .filter(Boolean);
            console.log(JSON.stringify({
                result: texts.join('\n'),
                usage: loop.state.tokenUsage,
                model: loop.state.model,
            }));
        } else if (outputFormat === 'stream-json') {
            const lastErr = results.find(e => e.type === 'error') || null;
            console.log(emitNdjson(resultSuccess({
                sessionId,
                result: assistantBits.join('') || (lastErr?.message || ''),
                usage: loop.state.tokenUsage,
                durationMs: Date.now() - started,
                numTurns: loop.state.turnCount,
                isError: Boolean(lastErr),
            })));
        } else {
            console.log('');
        }

        await cleanup();
    } else {
        // Interactive: use Ink React TUI
        try {
            const { startInkApp } = await import('./ui/app.mjs');
            const inkInstance = startInkApp(loop, settings);

            // Wait for Ink to exit (user pressed Ctrl+C or /quit)
            await inkInstance.waitUntilExit();
        } catch (err) {
            // Fallback to readline REPL if Ink fails (e.g. no TTY, missing deps)
            if (settings.debug) {
                console.error(`Ink UI unavailable (${err.message}), falling back to readline REPL`);
            }
            const { startRepl } = await import('./ui/repl.mjs');
            await startRepl(loop, settings);
        }
        await cleanup();
    }
}

function writeOfficialStreamJson(event, { sessionId, model, assistantBits }) {
    switch (event.type) {
        case 'stream_event':
            if (event.text) {
                assistantBits.push(event.text);
                console.log(emitNdjson(streamEventWrap({
                    type: 'content_block_delta',
                    delta: { type: 'text_delta', text: event.text },
                }, sessionId)));
            }
            break;
        case 'thinking':
            console.log(emitNdjson(streamEventWrap({
                type: 'content_block_delta',
                delta: { type: 'thinking_delta', thinking: event.text || '' },
            }, sessionId)));
            break;
        case 'assistant':
            if (event.content) {
                const text = sanitizeAssistantCanvas(event.content);
                if (text && !assistantBits.includes(text)) assistantBits.push(text);
                console.log(emitNdjson(assistantMessage({
                    sessionId,
                    model,
                    content: [{ type: 'text', text: text || event.content }],
                })));
            }
            break;
        case 'result':
            if (event.tool && event.result != null) {
                console.log(emitNdjson(userToolResult({
                    sessionId,
                    toolResults: [{
                        type: 'tool_result',
                        tool_use_id: event.tool_use_id || event.tool,
                        content: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
                    }],
                })));
            }
            break;
        case 'error':
            break;
        default:
            break;
    }
}

function handleEvent(event, settings = {}) {
    switch (event.type) {
        case 'stream_request_start':
            break;
        case 'stream_event':
            process.stdout.write(sanitizeAssistantCanvas(event.text || ''));
            break;
        case 'thinking':
            if (process.env.SHOW_THINKING || settings.verbose || settings.showThinking) {
                process.stdout.write(`\x1b[2m${event.text}\x1b[0m`);
            }
            break;
        case 'assistant': {
            const text = sanitizeAssistantCanvas(event.content);
            if (!event._streamed && text) console.log(text);
            break;
        }
        case 'tool_progress':
            process.stderr.write(`\x1b[33m[${event.tool}]\x1b[0m running...\n`);
            break;
        case 'result':
            break;
        case 'compaction':
            process.stderr.write(`\x1b[2m[compaction #${event.count}]\x1b[0m\n`);
            break;
        case 'hookPermissionResult':
            if (!event.allowed) {
                process.stderr.write(`\x1b[31m[blocked: ${event.tool}]\x1b[0m\n`);
            }
            break;
        case 'error':
            console.error(`\x1b[31mError: ${event.message}\x1b[0m`);
            break;
        case 'stop':
            break;
        default:
            break;
    }
}

main().catch(e => { console.error(e); process.exit(1); });
