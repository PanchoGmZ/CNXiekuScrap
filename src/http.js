import { lookup } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { PassThrough, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkServerIdentity } from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { log } from 'apify';

export const MAX_BYTES = 2 * 1024 * 1024;
export const hasControls = (value) =>
    Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
export class ScrapeError extends Error {
    constructor(code, message, status = 'error', httpStatus = null, retryAfter = null) {
        super(message);
        Object.assign(this, { code, status, httpStatus, retryAfter });
    }
}
export function validateUrl(raw, kind = 'product') {
    let url;
    try {
        if (typeof raw !== 'string' || !/^https:\/\//i.test(raw) || /[\s\\]/.test(raw) || hasControls(raw))
            throw new Error();
        url = new URL(raw);
        const authority = raw.slice(raw.indexOf('://') + 3).split(/[/?#]/)[0];
        if (
            url.hostname !== 'www.cnxieku.com' ||
            url.username ||
            url.password ||
            authority.includes('@') ||
            url.port ||
            raw.includes('#')
        )
            throw new Error();
        if (kind === 'product') {
            if (!/^\/item\/[1-9]\d{0,19}$/.test(url.pathname) || url.search) throw new Error();
        } else {
            const keys =
                kind === 'page'
                    ? ['keyword', 'searchType']
                    : ['page', 'size', 'keyword', 'productType', 'sortType', 'shopId'];
            if (
                !['page', 'api'].includes(kind) ||
                [...url.searchParams.keys()].some((key) => !keys.includes(key)) ||
                keys.some((key) => url.searchParams.getAll(key).length !== 1)
            )
                throw new Error();
            const query = url.searchParams.get('keyword');
            if (!query?.trim() || Array.from(query).length > 200 || hasControls(query)) throw new Error();
            if (kind === 'page') {
                if (url.pathname !== '/search/' || url.searchParams.get('searchType') !== '1') throw new Error();
            } else if (
                url.pathname !== '/api/product/product/list' ||
                url.searchParams.get('page') !== '1' ||
                !/^(?:[1-9]|1\d|20)$/.test(url.searchParams.get('size')) ||
                url.searchParams.get('productType') !== '8' ||
                url.searchParams.get('sortType') !== '1' ||
                url.searchParams.get('shopId') !== '-1'
            )
                throw new Error();
        }
    } catch {
        throw new ScrapeError(
            'UNSAFE_URL',
            'Se requiere una ruta CNXieku HTTPS permitida, sin credenciales, fragmentos ni parámetros ajenos.',
        );
    }
    return url;
}
export function isPublicAddress(address) {
    if (isIP(address) === 4) {
        const [a, b, c] = address.split('.').map(Number);
        return !(
            a === 0 ||
            a === 10 ||
            a === 127 ||
            a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
            (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
            (a === 203 && b === 0 && c === 113)
        );
    }
    if (isIP(address) !== 6 || address.includes('%')) return false;
    const [first, second = '0'] = address.toLowerCase().split(':');
    const prefix = Number.parseInt(first, 16);
    const subnet = Number.parseInt(second || '0', 16);
    return (
        prefix >= 0x2000 &&
        prefix <= 0x3fff &&
        prefix !== 0x2002 &&
        !(prefix === 0x2001 && (subnet <= 0x1ff || subnet === 0xdb8)) &&
        !(prefix === 0x3fff && subnet <= 0xfff)
    );
}
function nativeCode(error) {
    return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : null;
}
function cancelled(signal) {
    return signal.reason?.name === 'TimeoutError'
        ? new ScrapeError('REQUEST_TIMEOUT', 'Se agotó el plazo total de la operación.', 'timeout')
        : new ScrapeError('RUN_ABORTED', 'La ejecución fue detenida.');
}
function publicDns(hostname, signal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let abort;
        const finish = (error, addresses) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve(addresses);
        };
        abort = () => finish(cancelled(signal));
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener('abort', abort, { once: true });
        lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
            if (settled) return;
            if (error) {
                const code = nativeCode(error);
                log.warning('Falló DNS de CNXieku.', { code, syscall: error.syscall ?? null });
                finish(new ScrapeError('DNS_ERROR', `No se pudo resolver CNXieku${code ? ` (${code})` : ''}.`));
                return;
            }
            if (
                !addresses?.length ||
                addresses.some((entry) => isIP(entry.address) !== entry.family || !isPublicAddress(entry.address))
            ) {
                finish(
                    new ScrapeError('UNSAFE_ADDRESS', 'DNS contiene una dirección no pública o inválida.', 'blocked'),
                );
                return;
            }
            finish(null, addresses);
        });
    });
}
function comparable(address) {
    if (address?.startsWith('::ffff:') && address.slice(7).includes('.')) return address.slice(7);
    return address?.includes(':') ? new URL(`http://[${address}]/`).hostname : address;
}
function decode(bytes, contentType, maxBytes) {
    const prefix = bytes.subarray(0, 1024).toString('latin1');
    const charset =
        contentType.match(/charset\s*=\s*["']?([a-zA-Z0-9._-]+)/i)?.[1] ??
        prefix.match(/<meta\b[^>]{0,512}\bcharset\s*=\s*["']?([a-zA-Z0-9._-]+)/i)?.[1] ??
        'utf-8';
    let decoder;
    try {
        decoder = new TextDecoder(charset, { fatal: true });
    } catch {
        throw new ScrapeError('UNSUPPORTED_CHARSET', 'La codificación de la respuesta no está admitida.');
    }
    let text;
    try {
        text = decoder.decode(bytes);
    } catch {
        throw new ScrapeError('INVALID_TEXT_ENCODING', 'La respuesta contiene texto inválido.');
    }
    if (Buffer.byteLength(text) > maxBytes)
        throw new ScrapeError('RESPONSE_TOO_LARGE', 'El texto decodificado excede el límite.');
    return text;
}
export function createSession(input, parentSignal, timings) {
    if (
        !['product', 'search'].includes(input.mode) ||
        !Number.isInteger(input.timeoutSecs) ||
        input.timeoutSecs < 1 ||
        input.timeoutSecs > 60 ||
        !Number.isInteger(input.maxResponseBytes) ||
        input.maxResponseBytes < 1024 ||
        input.maxResponseBytes > MAX_BYTES
    ) {
        throw new ScrapeError('INVALID_REQUEST_POLICY', 'La solicitud no cumple los límites de la operación.');
    }
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(input.timeoutSecs * 1000)]);
    const requestOrder = input.mode === 'search' ? ['page', 'api'] : ['product'];
    let count = 0;
    return async (rawUrl, kind) => {
        const url = validateUrl(rawUrl, kind);
        if (count >= requestOrder.length)
            throw new ScrapeError('REQUEST_LIMIT', 'Se alcanzó el límite de solicitudes.');
        if (kind !== requestOrder[count])
            throw new ScrapeError('INVALID_REQUEST_POLICY', 'La ruta no corresponde a esta operación.');
        count++;
        const started = performance.now();
        const report = { url: url.href, httpStatus: null, downloadMs: 0, errorCode: null };
        timings.requests.push(report);
        try {
            if (signal.aborted) throw cancelled(signal);
            const [pin] = await publicDns(url.hostname, signal);
            if (signal.aborted) throw cancelled(signal);
            return await new Promise((resolve, reject) => {
                let outgoing;
                let incoming;
                let settled = false;
                let abort;
                let phase = 'tcp';
                const finish = (error, body) => {
                    if (settled) return;
                    settled = true;
                    signal.removeEventListener('abort', abort);
                    incoming?.destroy();
                    outgoing?.destroy();
                    if (error) reject(error);
                    else resolve(body);
                };
                const fail = (error) => {
                    if (signal.aborted) {
                        finish(cancelled(signal));
                        return;
                    }
                    if (error instanceof ScrapeError) {
                        finish(error);
                        return;
                    }
                    const code = nativeCode(error);
                    log.warning('Falló el transporte HTTPS de CNXieku.', {
                        phase,
                        code,
                        syscall: error?.syscall ?? null,
                    });
                    const tls = phase === 'tls' || /CERT|TLS|SSL|X509|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code ?? '');
                    const timeout = code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT';
                    const category = timeout
                        ? 'REQUEST_TIMEOUT'
                        : tls
                          ? 'TLS_ERROR'
                          : phase === 'tcp'
                            ? 'TCP_ERROR'
                            : 'HTTP_ERROR';
                    const message = timeout
                        ? 'Se agotó el tiempo de conexión'
                        : tls
                          ? 'No se pudo completar o verificar TLS'
                          : phase === 'tcp'
                            ? 'No se pudo establecer la conexión TCP'
                            : 'No se pudo completar la respuesta HTTP';
                    finish(
                        new ScrapeError(
                            category,
                            `${message}${code ? ` (${code})` : ''}.`,
                            timeout ? 'timeout' : 'error',
                        ),
                    );
                };
                abort = () => finish(cancelled(signal));
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) {
                    abort();
                    return;
                }
                const consume = async (response) => {
                    if (settled) {
                        response.destroy();
                        return;
                    }
                    incoming = response;
                    const status = response.statusCode;
                    report.httpStatus = status ?? null;
                    if (!status || status < 100 || status > 599)
                        throw new ScrapeError('INVALID_RESPONSE', 'HTTP inválido.');
                    if (response.socket.authorized !== true)
                        throw new ScrapeError('TLS_ERROR', 'TLS no está verificado.');
                    if (comparable(response.socket.remoteAddress) !== comparable(pin.address))
                        throw new ScrapeError('UNSAFE_ADDRESS', 'La IP remota no coincide con DNS.', 'blocked');
                    if (response.rawHeaders.length > 128)
                        throw new ScrapeError('RESPONSE_HEADERS_TOO_LARGE', 'Demasiados encabezados HTTP.');
                    if (status >= 300 && status < 400)
                        throw new ScrapeError('REDIRECT_LIMIT', 'CNXieku no admite redirecciones.', 'blocked', status);
                    const retry = response.headers['retry-after'];
                    const retryAfter =
                        typeof retry === 'string' &&
                        retry.length <= 128 &&
                        (/^\d+$/.test(retry) ||
                            (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
                                retry,
                            ) &&
                                Number.isFinite(Date.parse(retry))))
                            ? retry
                            : null;
                    if ([401, 403, 429].includes(status) || response.headers['cf-mitigated'] === 'challenge') {
                        throw new ScrapeError(
                            status === 429 ? 'RATE_LIMITED' : 'ACCESS_BLOCKED',
                            'El acceso está restringido; no se reintentó.',
                            'blocked',
                            status,
                            retryAfter,
                        );
                    }
                    if ([404, 410].includes(status))
                        throw new ScrapeError(
                            'PRODUCT_NOT_FOUND',
                            'La ruta solicitada no existe.',
                            'not_found',
                            status,
                        );
                    if ([408, 504].includes(status))
                        throw new ScrapeError('REQUEST_TIMEOUT', 'El servidor agotó el tiempo.', 'timeout', status);
                    if (status < 200 || status >= 300)
                        throw new ScrapeError('HTTP_ERROR', 'HTTP no satisfactorio.', 'error', status);
                    const type = response.headers['content-type'] ?? '';
                    const mime = type.split(';')[0].trim().toLowerCase();
                    if (
                        !(kind === 'api' ? ['application/json'] : ['text/html', 'application/xhtml+xml']).includes(mime)
                    ) {
                        throw new ScrapeError(
                            'UNSUPPORTED_CONTENT_TYPE',
                            'La respuesta no declara el tipo de contenido esperado.',
                        );
                    }
                    const length = response.headers['content-length'];
                    if (length && (!/^\d+$/.test(length) || Number(length) > input.maxResponseBytes))
                        throw new ScrapeError('RESPONSE_TOO_LARGE', 'La respuesta excede el límite.');
                    const encoding = (response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
                    const decoders = {
                        gzip: createGunzip,
                        br: createBrotliDecompress,
                        deflate: createInflate,
                        identity: () => new PassThrough(),
                    };
                    if (!Object.hasOwn(decoders, encoding))
                        throw new ScrapeError('UNSUPPORTED_CONTENT_ENCODING', 'Compresión no admitida.');
                    const chunks = [];
                    let wireBytes = 0;
                    let bodyBytes = 0;
                    const limit = new Transform({
                        transform(chunk, _encoding, callback) {
                            wireBytes += chunk.length;
                            callback(
                                wireBytes > input.maxResponseBytes
                                    ? new ScrapeError('RESPONSE_TOO_LARGE', 'La descarga excede el límite.')
                                    : null,
                                chunk,
                            );
                        },
                    });
                    const sink = new Writable({
                        write(chunk, _encoding, callback) {
                            bodyBytes += chunk.length;
                            if (bodyBytes > input.maxResponseBytes)
                                callback(
                                    new ScrapeError(
                                        'RESPONSE_TOO_LARGE',
                                        'El contenido descomprimido excede el límite.',
                                    ),
                                );
                            else {
                                chunks.push(Buffer.from(chunk));
                                callback();
                            }
                        },
                    });
                    await pipeline(response, limit, decoders[encoding](), sink, { signal });
                    if (!response.complete)
                        throw new ScrapeError('INCOMPLETE_RESPONSE', 'La respuesta terminó incompleta.');
                    finish(null, decode(Buffer.concat(chunks), type, input.maxResponseBytes));
                };
                try {
                    outgoing = request(
                        url,
                        {
                            method: 'GET',
                            port: 443,
                            family: pin.family,
                            autoSelectFamily: false,
                            agent: false,
                            lookup(hostname, options, callback) {
                                if (hostname !== url.hostname) {
                                    callback(new Error('Unexpected hostname'));
                                    return;
                                }
                                if (options.all) callback(null, [pin]);
                                else callback(null, pin.address, pin.family);
                            },
                            rejectUnauthorized: true,
                            checkServerIdentity,
                            servername: url.hostname,
                            minVersion: 'TLSv1.2',
                            ALPNProtocols: ['http/1.1'],
                            maxHeaderSize: 16 * 1024,
                            signal,
                            headers: {
                                'user-agent': 'TU-CUMPA-CNXieku/0.0.1',
                                accept: kind === 'api' ? 'application/json' : 'text/html, application/xhtml+xml',
                                'accept-encoding': 'gzip, br, deflate',
                                connection: 'close',
                                ...(kind === 'api' ? { 'x-client-type': 'pc' } : {}),
                            },
                        },
                        (response) => {
                            void consume(response).catch(fail);
                        },
                    );
                    outgoing.on('error', fail);
                    outgoing.on('socket', (socket) => {
                        socket.once('connect', () => {
                            phase = 'tls';
                        });
                        socket.once('secureConnect', () => {
                            phase = 'http';
                        });
                    });
                    outgoing.on('upgrade', (_response, socket) => {
                        socket.destroy();
                        fail(new ScrapeError('UNEXPECTED_UPGRADE', 'Cambio de protocolo no permitido.'));
                    });
                    if (settled) outgoing.destroy();
                    else outgoing.end();
                } catch (error) {
                    fail(error);
                }
            });
        } catch (error) {
            let safe =
                error instanceof ScrapeError
                    ? error
                    : new ScrapeError('NETWORK_ERROR', 'No se pudo completar la solicitud.');
            if (signal.aborted) safe = cancelled(signal);
            safe.httpStatus ??= report.httpStatus;
            report.errorCode = safe.code;
            throw safe;
        } finally {
            report.downloadMs = performance.now() - started;
            Object.assign(timings, { downloadMs: (timings.downloadMs ?? 0) + report.downloadMs });
        }
    };
}
