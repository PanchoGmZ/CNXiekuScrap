import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { Actor, log } from 'apify';

import { ScrapeError } from './http.js';

export const RESULT_STORE_NAME = 'cnxieku-results';
const LOCK_SECS = 300;
const STORAGE_TIMEOUT_SECS = 15;

export async function openResultStore() {
    const store = await Actor.openKeyValueStore(RESULT_STORE_NAME);
    // Bounded, non-retrying writes cannot outlive the renewed writer lease.
    const client = Actor.isAtHome() ? Actor.newClient({ maxRetries: 0, timeoutSecs: STORAGE_TIMEOUT_SECS }) : null;
    return {
        location: {
            storeName: RESULT_STORE_NAME,
            storeId: store.id,
            key: 'RESULT',
            apiUrl: `https://api.apify.com/v2/key-value-stores/${store.id}/records/RESULT`,
            consoleUrl: `https://console.apify.com/storage/key-value-stores/${store.id}`,
        },
        async acquire(signal) {
            let queue;
            let requestId;
            let file;
            let lockPath;
            let leaseDeadline;
            if (client) {
                const info = await client.requestQueues().getOrCreate(`${RESULT_STORE_NAME}-writer`);
                queue = client.requestQueue(info.id, { clientKey: randomUUID().replaceAll('-', '') });
                const added = await queue.addRequest({
                    uniqueKey: 'RESULT',
                    url: 'https://www.cnxieku.com/', // Lock identity only; never fetched.
                });
                const started = performance.now();
                const { items } = await queue.listAndLockHead({ limit: 1, lockSecs: LOCK_SECS });
                if (items[0]?.id !== added.requestId) {
                    throw new ScrapeError(
                        'RESULT_BUSY',
                        'Otra ejecución está actualizando RESULT; no se consultó la fuente.',
                        'blocked',
                    );
                }
                requestId = items[0].id;
                leaseDeadline = started + LOCK_SECS * 1000;
            } else {
                const dir = process.env.CRAWLEE_STORAGE_DIR ?? process.env.APIFY_LOCAL_STORAGE_DIR ?? './storage';
                await mkdir(dir, { recursive: true });
                lockPath = join(dir, '.cnxieku-result.lock');
                try {
                    file = await open(lockPath, 'wx');
                } catch (error) {
                    if (error.code !== 'EEXIST') throw error;
                    throw new ScrapeError('RESULT_BUSY', 'Otra ejecución local posee el bloqueo de RESULT.', 'blocked');
                }
            }
            return {
                async write(value) {
                    if (signal.aborted) throw new ScrapeError('RUN_ABORTED', 'La ejecución fue detenida.');
                    if (queue) {
                        if (performance.now() >= leaseDeadline) {
                            throw new ScrapeError('RESULT_LOCK_LOST', 'El bloqueo expiró; RESULT se conserva.');
                        }
                        const started = performance.now();
                        await queue.prolongRequestLock(requestId, { lockSecs: LOCK_SECS });
                        if (
                            signal.aborted ||
                            performance.now() - started >= (LOCK_SECS - STORAGE_TIMEOUT_SECS) * 1000
                        ) {
                            throw new ScrapeError(
                                'RESULT_LOCK_LOST',
                                'No hay un bloqueo vigente para escribir RESULT.',
                            );
                        }
                        await client.keyValueStore(store.id).setRecord(
                            {
                                key: 'RESULT',
                                value,
                                contentType: 'application/json',
                            },
                            { timeoutSecs: STORAGE_TIMEOUT_SECS, doNotRetryTimeouts: true },
                        );
                    } else {
                        await store.setValue('RESULT', value);
                    }
                },
                async release() {
                    try {
                        if (queue) await queue.deleteRequestLock(requestId);
                        else {
                            await file.close();
                            await unlink(lockPath);
                        }
                    } catch (error) {
                        log.warning('No se pudo liberar el bloqueo de RESULT.', {
                            code: error.code ?? error.type ?? null,
                        });
                    }
                },
            };
        },
    };
}
