import assert from 'node:assert/strict';
import { it } from 'node:test';

import { isPublicAddress, validateUrl } from '../src/http.js';
import { export1688, parseInput } from '../src/routes.js';

it('accepts only a product URL and its output format', () => {
    const url = 'https://www.cnxieku.com/item/20354';
    assert.equal(parseInput({ url }).outputFormat, 'canonical');
    assert.equal(parseInput({ url, outputFormat: 'reference1688' }).mode, 'product');
    for (const raw of [
        {},
        { mode: 'search', query: '' },
        { mode: 'search', query: 'x', maxResults: 21 },
        { url, mode: 'product' },
        { url, query: 'x' },
        { url, outputFormat: 'unknown' },
        { url: [url] },
    ])
        assert.throws(() => parseInput(raw));
});
it('restricts URLs and private addresses without any network calls', () => {
    assert.equal(validateUrl('https://www.cnxieku.com/item/20354').hostname, 'www.cnxieku.com');
    for (const url of [
        'http://www.cnxieku.com/item/20354',
        'https://cnxieku.com/item/20354',
        'https://127.0.0.1/item/20354',
        'https://www.cnxieku.com/item/20354#x',
        'https://www.cnxieku.com/catalogue',
    ])
        assert.throws(() => validateUrl(url));
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '2001:db8::1'])
        assert.equal(isPublicAddress(address), false);
    assert.equal(isPublicAddress('8.8.8.8'), true);
});
it('exports eleven fields without inventing currency, tier prices or SKU pictures', () => {
    const product = {
        url: null,
        title: null,
        price: { amount: 0, currency: null },
        moq: null,
        weight: null,
        dimensions: null,
        images: null,
        characteristics: null,
        variations: [{ title: 'A', price: null, images: null }],
        productId: '0001',
    };
    const output = export1688(product);
    assert.equal(Object.keys(output).length, 11);
    assert.equal(output.productId, '0001');
    assert.equal(output.price, '0');
    assert.equal(output.variations[0].variants[0].price, null);
    assert.equal(output.variations[0].variants[0].image, null);
    assert.deepEqual(output.productLadderPrices, []);
});
