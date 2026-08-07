import { log } from 'crawlee';
import { beforeAll, describe, expect, it } from 'vitest';

import { ContentCrawlerTypes } from '../src/const.js';
import { getCrawlerKey } from '../src/crawlers.js';
import { processInput, processStandbyInput } from '../src/input.js';
import type { ProxyOptions } from '../src/types.js';
import { parseParameters } from '../src/utils.js';

const cheerioKey = (proxyOptions: ProxyOptions = { useApifyProxy: true }) => (
    getCrawlerKey(ContentCrawlerTypes.CHEERIO, proxyOptions)
);

describe('getCrawlerKey', () => {
    // The key doubles as a request queue name, so it has to stay a short slug.
    it('is a slug of the crawler kind and a hash', () => {
        expect(cheerioKey()).toMatch(/^cheerio-[0-9a-f]+$/);
    });

    it('separates the crawler kinds', () => {
        const keys = new Set([
            getCrawlerKey('search', {}),
            getCrawlerKey(ContentCrawlerTypes.CHEERIO, {}),
            getCrawlerKey(ContentCrawlerTypes.PLAYWRIGHT, {}),
        ]);

        expect(keys.size).toBe(3);
    });

    it('ignores the order the proxy options were declared in', () => {
        const a = cheerioKey({ useApifyProxy: true, countryCode: 'US' });
        const b = cheerioKey({ countryCode: 'US', useApifyProxy: true });

        expect(a).toBe(b);
    });

    it('treats the apifyProxy* input-schema aliases as their canonical counterparts', () => {
        expect(cheerioKey({ apifyProxyGroups: ['RESIDENTIAL'] })).toBe(cheerioKey({ groups: ['RESIDENTIAL'] }));
        expect(cheerioKey({ apifyProxyCountry: 'US' })).toBe(cheerioKey({ countryCode: 'US' }));
    });

    it('collapses the useApifyProxy spellings the way the SDK does', () => {
        const noProxy = cheerioKey({ useApifyProxy: false });
        const custom = cheerioKey({ proxyUrls: ['http://proxy.example.com:8000'] });

        expect(cheerioKey({ useApifyProxy: true })).toBe(cheerioKey({}));
        expect(cheerioKey({ useApifyProxy: false, proxyUrls: ['http://proxy.example.com:8000'] })).toBe(custom);
        expect(cheerioKey({ useApifyProxy: false, tieredProxyUrls: [['http://a:1']] })).toBe(noProxy);
        expect(noProxy).not.toBe(custom);
    });

    it('never exposes proxy credentials, so the key is safe to log', () => {
        const key = cheerioKey({
            password: 'hunter2',
            proxyUrls: ['http://user:hunter2@proxy.example.com:8000'],
        });

        expect(key).not.toContain('hunter2');
        expect(key).not.toContain('proxy.example.com');
    });

    it('still separates crawlers that need a different proxy', () => {
        const keys = new Set([
            cheerioKey(),
            cheerioKey({ groups: ['RESIDENTIAL'] }),
            cheerioKey({ countryCode: 'US' }),
            cheerioKey({ useApifyProxy: false }),
            cheerioKey({ password: 'hunter2' }),
            cheerioKey({ proxyUrls: ['http://proxy.example.com:8000'] }),
            cheerioKey({ proxyUrls: ['http://other.example.com:8000'] }),
        ]);

        expect(keys.size).toBe(7);
    });
});

describe('standby requests reuse the crawlers started at boot', () => {
    process.env.ACTOR_FULL_NAME = 'apify/rag-web-browser';

    // A custom proxy keeps `Actor.createProxyConfiguration` off the network and off
    // `APIFY_PROXY_PASSWORD`, which it needs to return a `ProxyConfiguration` at all.
    const proxyConfiguration = { useApifyProxy: false, proxyUrls: ['http://proxy.invalid:8000'] };
    const query = (extraParams = '') => `?query=hello${extraParams}`;

    let bootKeys: string[];

    const requestFor = async (queryString: string) => {
        const { searchCrawlerOptions, contentCrawlerOptions, contentScraperSettings } = await processInput(
            parseParameters(queryString),
        );

        return {
            keys: [
                getCrawlerKey('search', searchCrawlerOptions.proxyOptions),
                getCrawlerKey(contentCrawlerOptions.type, contentCrawlerOptions.proxyOptions),
            ],
            contentScraperSettings,
        };
    };

    beforeAll(async () => {
        const { searchCrawlerOptions, contentCrawlerOptions } = await processStandbyInput({ proxyConfiguration });

        bootKeys = [
            getCrawlerKey('search', searchCrawlerOptions.proxyOptions),
            ...contentCrawlerOptions.map((o) => getCrawlerKey(o.type, o.proxyOptions)),
        ];
        expect(new Set(bootKeys).size).toBe(3);
    });

    it('reuses them for a plain request', async () => {
        expect(bootKeys).toEqual(expect.arrayContaining((await requestFor(query())).keys));
    });

    it('reuses them when debugMode is requested, and leaves the log level alone', async () => {
        const levelBefore = log.getLevel();

        expect(bootKeys).toEqual(expect.arrayContaining((await requestFor(query('&debugMode=true'))).keys));
        expect(log.getLevel()).toBe(levelBefore);
    });

    it('reuses them for every combination of the per-request crawl settings', async () => {
        for (const params of [
            '&requestTimeoutSecs=300',
            '&maxRequestRetries=0',
            '&desiredConcurrency=50',
            // The crawlers were built with a custom proxy, so asking for another one must not fork them.
            `&proxyConfiguration=${encodeURIComponent('{"useApifyProxy":true,"apifyProxyCountry":"US"}')}`,
            '&serpMaxRetries=0&maxRequestRetries=3&requestTimeoutSecs=7&desiredConcurrency=9',
        ]) {
            expect(bootKeys, params).toEqual(expect.arrayContaining((await requestFor(query(params))).keys));
        }
    });

    it('carries the narrowed settings on the request instead', async () => {
        const { contentScraperSettings } = await requestFor(query('&requestTimeoutSecs=7&maxRequestRetries=3'));

        expect(contentScraperSettings.requestTimeoutSecs).toBe(7);
        expect(contentScraperSettings.maxRequestRetries).toBe(3);
    });

    // Crawlee hands the hooks an empty object for Cheerio and the crawler's own timeout for
    // Playwright, which the request may then only lower.
    it.each([
        [ContentCrawlerTypes.CHEERIO, '', {}, { request: 3000 }],
        [ContentCrawlerTypes.PLAYWRIGHT, '&scrapingTool=browser-playwright', { timeout: 60_000 }, 3000],
    ])('narrows the %s navigation timeout to the requested one', async (_type, tool, initial, expected) => {
        const { contentCrawlerOptions, contentScraperSettings } = await processInput(
            parseParameters(query(`${tool}&requestTimeoutSecs=3`)),
        );
        const hooks = contentCrawlerOptions.crawlerOptions.preNavigationHooks!;
        const gotoOptions: Record<string, unknown> = { ...initial };

        await hooks[hooks.length - 1](
            { request: { userData: { contentScraperSettings } } } as never,
            gotoOptions as never,
        );

        expect(gotoOptions.timeout).toEqual(expected);
    });
});
