import assert from 'node:assert/strict';
import { it } from 'node:test';

import { isPublicAddress, requireAccess, validateUrl } from '../src/http.js';
import { export1688, parseInput } from '../src/routes.js';

it('validates modes, numeric codes, Unicode and bounded inputs', () => {
    assert.equal(parseInput({ mode: 'search', query: ' 1937 ' }).query, '1937');
    assert.equal(parseInput({ mode: 'search', query: '跑步鞋 & 男鞋' }).maxResults, 10);
    for (const raw of [
        { mode: 'search', query: '' },
        { mode: 'search', query: 'x', maxResults: 21 },
        { url: 'https://www.cnxieku.com/item/20354', query: 'x' },
        { url: ['https://www.cnxieku.com/item/20354'] },
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
it('requires both declared search permissions before I/O', () => {
    const previous = process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
    try {
        delete process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
        assert.throws(() => requireAccess('product'));
        process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = JSON.stringify({
            'www.cnxieku.com': {
                permissionBasis: 'project-declared',
                robotsException: true,
                allowProductGet: true,
            },
        });
        assert.doesNotThrow(() => requireAccess('product'));
        assert.throws(() => requireAccess('search'));
    } finally {
        if (previous === undefined) delete process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
        else process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = previous;
    }
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
