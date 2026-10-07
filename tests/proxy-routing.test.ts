import { Actor } from 'apify';
import type { PlaywrightCrawlerOptions } from 'crawlee';
import { describe, expect, it, vi } from 'vitest';

import { ContentCrawlerTypes } from '../src/const.js';
import { processInput } from '../src/input.js';
import type { ProxyOptions } from '../src/types.js';
import { parseParameters } from '../src/utils.js';

process.env.ACTOR_FULL_NAME = 'apify/rag-web-browser';

// A custom proxy everywhere keeps `Actor.createProxyConfiguration` off the network: the default
// `{useApifyProxy:true}` would check proxy access against Apify on every call.
const ACTOR_PROXY = { useApifyProxy: false, proxyUrls: ['http://actor-default.invalid:8000'] };
const inputFor = async (params = '', proxy: ProxyOptions = ACTOR_PROXY) => processInput(
    parseParameters(`?query=hello&proxyConfiguration=${encodeURIComponent(JSON.stringify(proxy))}${params}`),
);

describe('the shared crawlers route each request through its own proxy', () => {
    // Nothing here is mocked, so this exercises the real dispatching configuration.
    const proxyUrlFor = async (params: string, proxyOptions: ProxyOptions) => {
        const { contentCrawlerOptions } = await inputFor(params);
        const configuration = contentCrawlerOptions.crawlerOptions.proxyConfiguration!;

        return configuration.newUrl('session', { request: { userData: { proxyOptions } } } as never);
    };

    it.each(['', '&scrapingTool=browser-playwright'])('resolves the proxy from the request%s', async (params) => {
        const first = { useApifyProxy: false, proxyUrls: ['http://first.invalid:8000'] };
        const second = { useApifyProxy: false, proxyUrls: ['http://second.invalid:8000'] };

        expect(await proxyUrlFor(params, first)).toBe('http://first.invalid:8000');
        expect(await proxyUrlFor(params, second)).toBe('http://second.invalid:8000');
    });

    it('sends a request that asked for no proxy without one', async () => {
        expect(await proxyUrlFor('', { useApifyProxy: false })).toBeUndefined();
    });

    // Nothing above would catch this: without incognito pages BrowserPool hands a request whichever
    // browser has capacity and ignores the proxy that request resolved to, so every caller silently
    // shares the proxy the first browser launched with.
    it('gives the browser crawler a context per page, which is what makes the above work', async () => {
        const { contentCrawlerOptions } = await inputFor('&scrapingTool=browser-playwright');

        expect(contentCrawlerOptions.type).toBe(ContentCrawlerTypes.PLAYWRIGHT);
        expect((contentCrawlerOptions.crawlerOptions as PlaywrightCrawlerOptions).launchContext)
            .toMatchObject({ useIncognitoPages: true });
    });

    it('builds a proxy configuration once instead of on every request', async () => {
        const createProxyConfiguration = vi.spyOn(Actor, 'createProxyConfiguration').mockResolvedValue(undefined);
        // Proxy options no other test uses, so the count cannot be satisfied by an already warm cache.
        const proxy = { useApifyProxy: false, proxyUrls: ['http://cache-probe.invalid:8000'] };

        await inputFor('', proxy);
        await inputFor('&maxResults=2', proxy);

        expect(createProxyConfiguration).toHaveBeenCalledTimes(1);
        createProxyConfiguration.mockRestore();
    });
});
