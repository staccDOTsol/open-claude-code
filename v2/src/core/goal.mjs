/**
 * Session goal — keep the agent-loop working until the goal is done.
 *
 * No grokui parser directives (RUN:/WRITE:/DONE:/NUDGE). Continuation is a
 * normal user message so the model keeps using tools instead of parking.
 */

export const DEFAULT_GOAL_CONTINUATION_CAP = 50;

export function isGoalActive(state) {
    return typeof state?.goal === 'string' && state.goal.trim().length > 0;
}

export function goalContinuationCap(settings = {}) {
    const n = Number(settings?.maxTurns);
    if (Number.isFinite(n) && n > 0) return n;
    return DEFAULT_GOAL_CONTINUATION_CAP;
}

/**
 * Continuation user text after a no-tool end_turn while a goal is active.
 * Must stay free of grokui parser directives.
 */
export function goalContinuationMessage(goal) {
    const text = String(goal || '').trim();
    return (
        `The user goal is still active: ${text}. ` +
        'Keep using tools until it is done. ' +
        'Do not ask what they would like to do. ' +
        'Do not tell them to type continue.'
    );
}

export function persistGoal(state) {
    const mgr = state?._sessionManager;
    if (!mgr || typeof mgr.save !== 'function') return null;
    return mgr.save(state);
}

export function setGoal(state, text) {
    state.goal = String(text || '').trim();
    state._goalContinuations = 0;
    persistGoal(state);
    return state.goal;
}

export function clearGoal(state) {
    state.goal = '';
    state._goalContinuations = 0;
    persistGoal(state);
}
