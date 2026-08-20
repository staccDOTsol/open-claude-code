/**
 * Finder-launched grokui has no nvm `node` on PATH. It runs this .mjs
 * under ELECTRON_RUN_AS_NODE=1 with Electron as execPath. Do not re-spawn
 * `node` from PATH — use process.execPath.
 */

export function isElectronAsNode(env = process.env, versions = process.versions) {
    return env.ELECTRON_RUN_AS_NODE === '1' || Boolean(versions?.electron);
}

/** Runtime binary that can execute this ESM entry. */
export function runtimeExecPath() {
    return process.execPath;
}

export function spawnEnv(env = process.env) {
    if (!isElectronAsNode(env)) return { ...env };
    return { ...env, ELECTRON_RUN_AS_NODE: '1' };
}
