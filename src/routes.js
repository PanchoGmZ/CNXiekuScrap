import { createRequire } from 'node:module';

import { createSession, MAX_BYTES, ScrapeError, validateUrl } from './http.js';

const { load } = createRequire(import.meta.resolve('@crawlee/cheerio'))('cheerio');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const number = (value) => {
    const amount = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : value;
    return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : null;
};
const id = (value) => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    return text(value);
};
export function parseInput(raw) {
    if (!record(raw)) throw new ScrapeError('INVALID_INPUT', 'La entrada debe ser un objeto JSON.');
    const allowed = ['url', 'outputFormat'];
    if (Object.keys(raw).some((key) => !allowed.includes(key)))
        throw new ScrapeError('INVALID_INPUT', 'Solo se admiten url y outputFormat.');
    const outputFormat = raw.outputFormat === undefined ? 'canonical' : raw.outputFormat;
    if (!['canonical', 'reference1688'].includes(outputFormat)) {
        throw new ScrapeError('INVALID_OUTPUT_FORMAT', 'outputFormat debe ser canonical o reference1688.');
    }
    const timeoutSecs = Number(process.env.CNXIEKU_TIMEOUT_SECS ?? 30);
    const maxResponseBytes = Number(process.env.CNXIEKU_MAX_RESPONSE_BYTES ?? MAX_BYTES);
    if (!Number.isInteger(timeoutSecs) || timeoutSecs < 1 || timeoutSecs > 60)
        throw new ScrapeError('INVALID_TIMEOUT', 'CNXIEKU_TIMEOUT_SECS debe ser entero entre 1 y 60.');
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_BYTES)
        throw new ScrapeError('INVALID_SIZE_LIMIT', 'CNXIEKU_MAX_RESPONSE_BYTES debe estar entre 1024 y 2097152.');
    return { mode: 'product', url: validateUrl(raw.url).href, outputFormat, timeoutSecs, maxResponseBytes };
}
function nuxt(html) {
    const scripts = load(html)('script#__NUXT_DATA__[type="application/json"][data-nuxt-data="nuxt-app"]');
    let pool;
    try {
        if (scripts.length === 1) pool = JSON.parse(scripts.text());
    } catch {
        /* Refuse malformed state below. */
    }
    if (!Array.isArray(pool))
        throw new ScrapeError('INVALID_NUXT_STATE', 'La página no contiene un estado Nuxt único y válido.');
    const node = (index, depth = 0) => {
        if (depth > 8 || !Number.isInteger(index) || index < 0) return undefined;
        const value = pool[index];
        return Array.isArray(value) && value[0] === 'ShallowReactive' ? node(value[1], depth + 1) : value;
    };
    const field = (value, key) => (record(value) && Object.hasOwn(value, key) ? node(value[key]) : undefined);
    const entries = (value) => (Array.isArray(value) ? value.map((index) => node(index)) : null);
    return { root: node(0), field, entries };
}
function imageUrl(value, base, httpsOnly = false) {
    if (!text(value)) return null;
    try {
        const url = base ? new URL(value, base) : new URL(value);
        return (httpsOnly ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)) &&
            !url.username &&
            !url.password &&
            !/\s/.test(url.href)
            ? url.href
            : null;
    } catch {
        return null;
    }
}
export function extractProduct(html, sourceUrl) {
    const url = validateUrl(sourceUrl);
    const productId = url.pathname.split('/').at(-1);
    const { root, field, entries } = nuxt(html);
    const product = field(field(root, 'data'), `product-seo-${productId}`);
    const item = field(product, 'item');
    if (field(root, 'path') !== url.pathname || id(field(item, 'productId')) !== productId) {
        throw new ScrapeError('PRODUCT_URL_MISMATCH', 'Los datos Nuxt no pertenecen a la ficha solicitada.');
    }
    const base = text(field(field(field(root, 'pinia'), 'common'), 'storageUrl'));
    const picture = (value) => imageUrl(value, base);
    const images = [
        picture(field(item, 'picOriginal')),
        ...(entries(field(product, 'picList')) ?? []).map((pic) =>
            id(field(pic, 'productId')) === productId ? picture(field(pic, 'picOriginal')) : null,
        ),
        ...(entries(field(product, 'descArr')) ?? []).map((pic) =>
            field(pic, 'type') === 'pic' ? picture(field(pic, 'pic')) : null,
        ),
    ].filter(Boolean);
    const normal = entries(field(field(product, 'attrList'), 'normal'));
    const characteristics = [];
    for (const group of normal ?? []) {
        for (const attr of entries(field(group, 'attrList')) ?? []) {
            if (id(field(attr, 'productId')) !== productId) continue;
            const name = text(field(attr, 'attrName'));
            const raw = field(attr, 'attrValue');
            const value = Array.isArray(raw) ? (entries(raw) ?? []).map(text).filter(Boolean).join(', ') : text(raw);
            if (name && value) characteristics.push({ name, value });
        }
    }
    const skus = entries(field(product, 'skuList'));
    const variations =
        skus
            ?.filter((sku) => id(field(sku, 'productId')) === productId)
            .map((sku) => {
                const amount = number(field(sku, 'skuPrice'));
                const image = picture(field(sku, 'productUrl'));
                return {
                    productId: id(field(sku, 'skuId')),
                    title: text(field(sku, 'skuValue')),
                    price: amount === null ? null : { amount, currency: null },
                    images: image ? [image] : null,
                    characteristics:
                        entries(field(sku, 'skuData'))?.map((attr) => ({
                            name: text(field(attr, 'name')),
                            value: text(field(attr, 'value')),
                        })) ?? null,
                };
            }) ?? null;
    const amount = number(field(item, 'productPrice'));
    const minimum = number(field(item, 'minNumber'));
    const weightText = text(field(item, 'productWeight'));
    const match = weightText?.match(/^(\d+(?:\.\d+)?) kg$/);
    const weight = match ? number(match[1]) : null;
    if (weight === 0 && weightText) characteristics.push({ name: 'productWeight', value: weightText });
    return {
        url: url.href,
        title: text(field(item, 'productName')),
        price: amount === null ? null : { amount, currency: null },
        moq: Number.isInteger(minimum) && minimum >= 1 ? minimum : null,
        weight: weight !== null && weight > 0 ? { value: weight, unit: 'kg' } : null,
        dimensions: null,
        images: images.length ? [...new Set(images)] : null,
        characteristics: normal || characteristics.length ? characteristics : null,
        variations,
        productId,
    };
}
function missingFields(value, path = '') {
    if (value === null) return [path];
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, item]) => {
        let next = path ? `${path}.${key}` : key;
        if (Array.isArray(value)) next = `${path}[${key}]`;
        return missingFields(item, next);
    });
}
export function export1688(product) {
    const numericId = product.productId && /^(0|[1-9]\d*)$/.test(product.productId) ? Number(product.productId) : null;
    let variations = null;
    if (product.variations) {
        variations = [];
        if (product.variations.length)
            variations.push({
                name: 'Variación',
                variants: product.variations.map((sku) => ({
                    name: sku?.title ?? null,
                    price: sku?.price?.amount ?? null,
                    image: sku?.images?.[0] ?? null,
                })),
            });
    }
    return {
        url: product.url,
        title: product.title,
        price: product.price?.amount?.toString() ?? null,
        productLadderPrices: [],
        moq: product.moq,
        weight: product.weight?.value === 0 ? null : product.weight,
        dimensions: product.dimensions,
        images: product.images,
        characteristics:
            product.characteristics?.map((attr) => ({
                attrName: attr?.name ?? null,
                attrValue: attr?.value ?? null,
            })) ?? null,
        variations,
        productId: numericId !== null && Number.isSafeInteger(numericId) ? numericId : product.productId,
    };
}
function emptyProduct(url = null) {
    return {
        url,
        title: null,
        price: null,
        moq: null,
        weight: null,
        dimensions: null,
        images: null,
        characteristics: null,
        variations: null,
        productId: null,
    };
}
export function failure(input, error, timings) {
    const known = error instanceof ScrapeError;
    const status = known ? error.status : 'error';
    const httpStatus = error?.httpStatus ?? timings.requests.at(-1)?.httpStatus ?? null;
    const detail = {
        code: known ? error.code : 'EXTRACTION_ERROR',
        message: known ? error.message : 'No se pudo analizar la respuesta.',
        retryAfter: error?.retryAfter ?? null,
    };
    const product = emptyProduct(input?.url ?? null);
    return {
        requestedUrl: input?.url ?? null,
        source: input ? 'cnxieku' : null,
        mode: input?.mode ?? null,
        status,
        httpStatus,
        product,
        missingFields: missingFields(product),
        error: detail,
    };
}
function checkProtection(html) {
    if (
        /id=["']challenge-form["']|\/cdn-cgi\/challenge-platform\/|class=["'][^"']*(?:g-recaptcha|h-captcha)/i.test(
            html,
        )
    ) {
        throw new ScrapeError(
            'ACCESS_BLOCKED',
            'La página contiene una protección de acceso; no se reintentó.',
            'blocked',
        );
    }
}
export async function productRoute(input, signal, timings) {
    Object.assign(timings, { requestedUrl: input.url });
    const get = createSession(input, signal, timings);
    const html = await get(input.url, 'product');
    checkProtection(html);
    const started = performance.now();
    try {
        const product = extractProduct(html, input.url);
        const missing = missingFields(product);
        return {
            requestedUrl: input.url,
            source: 'cnxieku',
            mode: 'product',
            status: missing.length ? 'partial' : 'success',
            httpStatus: timings.requests.at(-1).httpStatus,
            product,
            missingFields: missing,
            error: null,
        };
    } finally {
        Object.assign(timings, { analysisMs: performance.now() - started });
    }
}
