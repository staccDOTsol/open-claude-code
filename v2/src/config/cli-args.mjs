/**
 * CLI Argument Parser — supports all major Claude Code flags.
 *
 * Flags:
 * --model, -m          Model to use
 * --permission-mode    Permission mode
 * --print, -p          Print mode (non-interactive prompt)
 * --output-format      json, text, stream-json
 * --system-prompt      Override system prompt
 * --add-dir            Additional CLAUDE.md directories
 * --max-turns          Maximum conversation turns
 * --allowedTools       Comma-separated allowed tools
 * --disallowedTools    Comma-separated denied tools
 * --verbose, -v        Verbose output
 * --debug, -d          Debug mode
 * --version            Show version
 * --help, -h           Show help
 */

export function parseArgs(args) {
    const result = {
        prompt: null,
        model: null,
        permissionMode: null,
        outputFormat: null,
        systemPrompt: null,
        addDirs: [],
        maxTurns: null,
        allowedTools: null,
        disallowedTools: null,
        verbose: false,
        debug: false,
        showVersion: false,
        showHelp: false,
        print: false,
        // Opt-in metaharness self-optimization. null = unset (defer to env/setting).
        selfOptimize: null,
    };

    const positionals = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--model':
            case '-m':
                result.model = args[++i];
                break;

            case '--permission-mode':
                result.permissionMode = args[++i];
                break;

            case '--dangerously-skip-permissions':
                result.permissionMode = 'bypassPermissions';
                break;

            case '--print':
            case '-p':
                // Boolean, like official Claude Code. Prompt is positional
                // (`occ -p hi` or `claude --print --output-format stream-json`).
                result.print = true;
                break;

            case '--output-format':
                result.outputFormat = args[++i];
                break;

            case '--system-prompt':
                result.systemPrompt = args[++i];
                break;

            case '--add-dir':
                result.addDirs.push(args[++i]);
                break;

            case '--max-turns':
                result.maxTurns = parseInt(args[++i], 10);
                break;

            case '--allowedTools':
                result.allowedTools = args[++i]?.split(',').map(s => s.trim());
                break;

            case '--disallowedTools':
                result.disallowedTools = args[++i]?.split(',').map(s => s.trim());
                break;

            case '--verbose':
            case '-v':
                result.verbose = true;
                break;

            case '--debug':
            case '-d':
                result.debug = true;
                break;

            case '--self-optimize':
                result.selfOptimize = true;
                break;

            case '--no-self-optimize':
                result.selfOptimize = false;
                break;

            case '--version':
                result.showVersion = true;
                break;

            case '--help':
            case '-h':
                result.showHelp = true;
                break;

            default:
                if (arg === '--print=true' || arg === '-p=true') {
                    result.print = true;
                    break;
                }
                // Bare argument becomes prompt (so `occ -p hi` still works)
                if (!arg.startsWith('-')) {
                    positionals.push(arg);
                }
                break;
        }
    }

    if (positionals.length) {
        result.prompt = positionals.join(' ');
    }

    return result;
}

/**
 * Print usage/help text.
 * @returns {string}
 */
export function getUsageText() {
    return `
Usage: openzoo-claude | occ | claude [options] [prompt]

OpenZoo Claude Code CLI — pay-per-call via the local zoo proxy (:8402).
Subscription Bearer or x402. Never ANTHROPIC_API_KEY / api.anthropic.com.

Options:
  --model, -m <model>        Model to use (never pass openzoo/auto — it is resolved)
  --permission-mode <mode>   Permission mode (bypassPermissions, acceptEdits, plan, auto, dontAsk)
  --dangerously-skip-permissions
                             Alias for --permission-mode bypassPermissions
  --print, -p                Print mode (boolean). Prompt is the positional argument
  --output-format <fmt>      Output format: text, json, stream-json
                             stream-json emits official Claude Code NDJSON
  --system-prompt <text>     Override system prompt
  --add-dir <dir>            Additional directory to search for CLAUDE.md
  --max-turns <n>            Maximum conversation turns
  --allowedTools <tools>     Comma-separated list of allowed tools
  --disallowedTools <tools>  Comma-separated list of denied tools
  --verbose, -v              Verbose output
  --debug, -d                Debug mode
  --self-optimize            Route model calls through the metaharness cost-cascade
                             (cheap base -> escalate) and record real outcomes (opt-in)
  --no-self-optimize         Force self-optimization off (overrides env/setting)
  --version                  Show version
  --help, -h                 Show this help

Env (applied automatically when :8402 /v1/info answers):
  ANTHROPIC_BASE_URL=http://localhost:8402/v1
  ANTHROPIC_AUTH_TOKEN=<subscription key or sk-openzoo>
  ANTHROPIC_API_KEY unset

Examples:
  occ                        Start interactive REPL
  occ -p hi                  Print mode (positional prompt)
  occ --print --output-format stream-json "hello"
  occ -m openzoo-claude-sonnet -p "explain this"
  occ --dangerously-skip-permissions -p "fix the bug"
`.trim();
}
