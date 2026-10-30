import { Actor, log } from 'apify';

import { export1688, failure, parseInput, productRoute, searchRoute } from './routes.js';

Actor.config.set('purgeOnStart', false);
await Actor.init({ gracefulShutdown: false });
const started = performance.now();
const controller = new AbortController();
const timings = { requests: [], downloadMs: null, analysisMs: null, searchMs: null, jsonGenerationMs: null };
const state = { source: null, status: 'running', savedResults: 0, resultStatus: null };
let result;
let input;
let task;
let stopping = false;
const persist = async () => {
    await Actor.setValue('TIMINGS', {
        environment: timings.requests.length ? 'public-https' : 'no-network',
        mode: input?.mode ?? result?.mode ?? null,
        ...timings,
        requestedUrl: timings.requestedUrl ?? null,
        resultStatus: state.resultStatus,
        httpStatus: result?.httpStatus ?? null,
        searchPerformed: input?.mode === 'search' && timings.requests.length > 0,
        totalMs: performance.now() - started,
        totalScope: 'Actor operation through dataset write; excludes SDK init/exit and report persistence',
    });
    await Actor.setValue('RUN_STATE', { ...state });
};
const onAbort = async () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    await task?.catch(() => undefined);
    state.status = 'aborted';
    try {
        await persist();
    } finally {
        await Actor.exit();
    }
};
Actor.on('aborting', onAbort);
try {
    task = (async () => {
        let raw;
        try {
            raw = await Actor.getInput();
            input = parseInput(raw);
            const route = input.mode === 'search' ? searchRoute : productRoute;
            result = await route(input, controller.signal, timings);
        } catch (error) {
            result = failure(input, error, timings, raw?.mode);
        }
        state.source = result.source;
        state.resultStatus = result.status;
        const beforeJson = performance.now();
        const output =
            input?.mode === 'product' && input.outputFormat === 'reference1688' && !result.error
                ? export1688(result.product)
                : result;
        const json = JSON.stringify(output);
        timings.jsonGenerationMs = performance.now() - beforeJson;
        await Actor.pushData(JSON.parse(json));
        state.savedResults = 1;
    })();
    await task;
    if (!stopping) {
        state.status = 'completed';
        await persist();
        if (!stopping) {
            log.info('CNXieku procesado.', {
                mode: input?.mode ?? null,
                status: state.resultStatus,
                savedResults: state.savedResults,
            });
            Actor.off('aborting', onAbort);
            await Actor.exit();
        }
    }
} catch (error) {
    if (!stopping) {
        state.status = 'failed';
        try {
            await persist();
        } catch {
            /* Storage itself may be unavailable. */
        }
        log.exception(error, 'No se pudo completar la persistencia del Actor.');
        Actor.off('aborting', onAbort);
        await Actor.exit({ exitCode: 1 });
    }
}
