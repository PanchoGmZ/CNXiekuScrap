import { Actor, log } from 'apify';

import { export1688, failure, parseInput, productRoute, searchRoute } from './routes.js';
import { openResultStore } from './result-store.js';

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
        totalScope: 'Actor operation through persistent RESULT write; excludes SDK init/exit and report persistence',
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
            const store = await openResultStore();
            await Actor.setValue('RESULT_LOCATION', store.location);
            input = parseInput(raw);
            const writer = await store.acquire(controller.signal);
            try {
                const route = input.mode === 'search' ? searchRoute : productRoute;
                result = await route(input, controller.signal, timings);
                if (!result.error && ['success', 'partial'].includes(result.status) && !controller.signal.aborted) {
                    const beforeJson = performance.now();
                    const output =
                        input.mode === 'product' && input.outputFormat === 'reference1688'
                            ? export1688(result.product)
                            : result;
                    const json = JSON.stringify({
                        schemaVersion: 1,
                        source: 'cnxieku',
                        mode: input.mode,
                        outputFormat: input.outputFormat,
                        status: result.status,
                        updatedAt: new Date().toISOString(),
                        runId: Actor.getEnv().actorRunId,
                        data: output,
                    });
                    timings.jsonGenerationMs = performance.now() - beforeJson;
                    await writer.write(JSON.parse(json));
                    state.savedResults = 1;
                }
            } finally {
                await writer.release();
            }
        } catch (error) {
            result = failure(input, error, timings, raw?.mode);
        }
        state.source = result.source;
        state.resultStatus = result.status;
        if (result.error) {
            await Actor.setValue('LAST_ERROR', {
                source: result.source,
                mode: result.mode,
                requestedUrl: result.requestedUrl,
                status: result.status,
                httpStatus: result.httpStatus,
                error: result.error,
            });
            log.error('La ejecución falló; se conserva el último RESULT válido.', result.error);
        }
    })();
    await task;
    if (!stopping) {
        state.status = state.savedResults ? 'completed' : 'failed';
        await persist();
        if (!stopping) {
            log.info('CNXieku procesado.', {
                mode: input?.mode ?? null,
                status: state.resultStatus,
                savedResults: state.savedResults,
            });
            Actor.off('aborting', onAbort);
            await Actor.exit({ exitCode: state.savedResults ? 0 : 1 });
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
