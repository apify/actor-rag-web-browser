import type { CheerioCrawlerOptions } from 'crawlee';
import { log } from 'crawlee';
import { beforeAll, describe, expect, it } from 'vitest';

import { ContentCrawlerTypes } from '../src/const.js';
import { getCrawlerKey } from '../src/crawlers.js';
import { processInput, processStandbyInput } from '../src/input.js';
import type { ProxyOptions } from '../src/types.js';
import { parseParameters } from '../src/utils.js';

const baseOptions: CheerioCrawlerOptions = {
    keepAlive: true,
    maxRequestRetries: 1,
    requestHandlerTimeoutSecs: 40,
    autoscaledPoolOptions: { desiredConcurrency: 5 },
};

const cheerioKey = (
    options: CheerioCrawlerOptions = {},
    proxyOptions: ProxyOptions = { useApifyProxy: true },
) => getCrawlerKey(ContentCrawlerTypes.CHEERIO, { ...baseOptions, ...options }, proxyOptions);

describe('getCrawlerKey', () => {
    // The key doubles as a request queue name, so it has to stay a short slug.
    it('is a slug of the crawler kind and a hash', () => {
        expect(cheerioKey()).toMatch(/^cheerio-[0-9a-f]+$/);
    });

    it('separates the crawler kinds', () => {
        const keys = new Set([
            getCrawlerKey('search', baseOptions, {}),
            getCrawlerKey(ContentCrawlerTypes.CHEERIO, baseOptions, {}),
            getCrawlerKey(ContentCrawlerTypes.PLAYWRIGHT, baseOptions, {}),
        ]);

        expect(keys.size).toBe(3);
    });

    it('ignores the order the proxy options were declared in', () => {
        const a = cheerioKey({}, { useApifyProxy: true, countryCode: 'US' });
        const b = cheerioKey({}, { countryCode: 'US', useApifyProxy: true });

        expect(a).toBe(b);
    });

    it('treats the apifyProxy* input-schema aliases as their canonical counterparts', () => {
        expect(cheerioKey({}, { apifyProxyGroups: ['RESIDENTIAL'] })).toBe(cheerioKey({}, { groups: ['RESIDENTIAL'] }));
        expect(cheerioKey({}, { apifyProxyCountry: 'US' })).toBe(cheerioKey({}, { countryCode: 'US' }));
    });

    it('collapses the useApifyProxy spellings the way the SDK does', () => {
        const noProxy = cheerioKey({}, { useApifyProxy: false });
        const custom = cheerioKey({}, { proxyUrls: ['http://proxy.example.com:8000'] });

        expect(cheerioKey({}, { useApifyProxy: true })).toBe(cheerioKey({}, {}));
        expect(cheerioKey({}, { useApifyProxy: false, proxyUrls: ['http://proxy.example.com:8000'] })).toBe(custom);
        expect(cheerioKey({}, { useApifyProxy: false, tieredProxyUrls: [['http://a:1']] })).toBe(noProxy);
        expect(noProxy).not.toBe(custom);
    });

    it('never exposes proxy credentials, so the key is safe to log', () => {
        const key = cheerioKey({}, {
            password: 'hunter2',
            proxyUrls: ['http://user:hunter2@proxy.example.com:8000'],
        });

        expect(key).not.toContain('hunter2');
        expect(key).not.toContain('proxy.example.com');
    });

    it('still separates crawlers whose settings genuinely differ', () => {
        const keys = new Set([
            cheerioKey(),
            cheerioKey({ keepAlive: false }),
            cheerioKey({ maxRequestRetries: 3 }),
            cheerioKey({ requestHandlerTimeoutSecs: 90 }),
            cheerioKey({ autoscaledPoolOptions: { desiredConcurrency: 10 } }),
            cheerioKey({}, { groups: ['RESIDENTIAL'] }),
            cheerioKey({}, { countryCode: 'US' }),
            cheerioKey({}, { useApifyProxy: false }),
            cheerioKey({}, { password: 'hunter2' }),
            cheerioKey({}, { proxyUrls: ['http://proxy.example.com:8000'] }),
            cheerioKey({}, { proxyUrls: ['http://other.example.com:8000'] }),
        ]);

        expect(keys.size).toBe(11);
    });
});

describe('standby requests reuse the crawlers started at boot', () => {
    process.env.ACTOR_FULL_NAME = 'apify/rag-web-browser';

    // A custom proxy keeps `Actor.createProxyConfiguration` off the network and off
    // `APIFY_PROXY_PASSWORD`, which it needs to return a `ProxyConfiguration` at all.
    const proxyConfiguration = { useApifyProxy: false, proxyUrls: ['http://proxy.invalid:8000'] };
    const query = (extraParams = '') => `?query=hello&proxyConfiguration=${
        encodeURIComponent(JSON.stringify(proxyConfiguration))}${extraParams}`;

    let bootKeys: string[];

    const keysForRequest = async (queryString: string) => {
        const { searchCrawlerOptions, contentCrawlerOptions } = await processInput(parseParameters(queryString));
        // Mirrors `runSearchProcess`, which forces keepAlive to match the crawlers started at boot.
        searchCrawlerOptions.crawlerOptions.keepAlive = true;
        contentCrawlerOptions.crawlerOptions.keepAlive = true;

        return [
            getCrawlerKey('search', searchCrawlerOptions.crawlerOptions, searchCrawlerOptions.proxyOptions),
            getCrawlerKey(contentCrawlerOptions.type, contentCrawlerOptions.crawlerOptions, contentCrawlerOptions.proxyOptions),
        ];
    };

    beforeAll(async () => {
        const { searchCrawlerOptions, contentCrawlerOptions } = await processStandbyInput({ proxyConfiguration });

        bootKeys = [
            getCrawlerKey('search', searchCrawlerOptions.crawlerOptions, searchCrawlerOptions.proxyOptions),
            ...contentCrawlerOptions.map((o) => getCrawlerKey(o.type, o.crawlerOptions, o.proxyOptions)),
        ];
        expect(new Set(bootKeys).size).toBe(3);
    });

    it('reuses them for a plain request', async () => {
        expect(bootKeys).toEqual(expect.arrayContaining(await keysForRequest(query())));
    });

    it('reuses them when debugMode is requested, and leaves the log level alone', async () => {
        const levelBefore = log.getLevel();

        expect(bootKeys).toEqual(expect.arrayContaining(await keysForRequest(query('&debugMode=true'))));
        expect(log.getLevel()).toBe(levelBefore);
    });
});
