import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { MemoryStorage } from '@crawlee/memory-storage';
import { Actor, RequestQueue } from 'apify';
import type { PlaywrightCrawlerOptions } from 'crawlee';
import { PlaywrightCrawler } from 'crawlee';
import { describe, expect, it, vi } from 'vitest';

import { ContentCrawlerTypes } from '../src/const.js';
import { processInput } from '../src/input.js';
import type { ProxyOptions } from '../src/types.js';
import { parseParameters } from '../src/utils.js';

process.env.ACTOR_FULL_NAME = 'apify/rag-web-browser';

// A custom proxy keeps `Actor.createProxyConfiguration` off the network.
const ACTOR_PROXY = { useApifyProxy: false, proxyUrls: ['http://actor-default.invalid:8000'] };
const inputFor = async (params = '', proxy: ProxyOptions = ACTOR_PROXY) => processInput(
    parseParameters(`?query=hello&proxyConfiguration=${encodeURIComponent(JSON.stringify(proxy))}${params}`),
);

describe('the shared crawlers route each request through its own proxy', () => {
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

    // Resolving no proxy is not the same as using none: a page that resolved none falls back to
    // the proxy its browser launched with, which is the previous caller's.
    it('keeps a caller who asked for no proxy off the proxy another caller is using', async () => {
        const seenByOtherCallersProxy: string[] = [];
        const otherCallersProxy = http.createServer((req, res) => {
            seenByOtherCallersProxy.push(req.url!);
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<html><body><p>ok</p></body></html>');
        });
        await new Promise<void>((resolve) => { otherCallersProxy.listen(0, '127.0.0.1', resolve); });
        const proxyUrl = `http://127.0.0.1:${(otherCallersProxy.address() as AddressInfo).port}`;

        const recorded: string[] = [];
        const { contentCrawlerOptions } = await inputFor('&scrapingTool=browser-playwright');
        const requestQueue = await RequestQueue.open('proxy-probe-queue', {
            storageClient: new MemoryStorage({ persistStorage: false }),
        });
        const crawler = new PlaywrightCrawler({
            ...contentCrawlerOptions.crawlerOptions as PlaywrightCrawlerOptions,
            requestQueue,
            keepAlive: false,
            maxRequestRetries: 0,
            // One page at a time, so the proxied request is the one that launches the browser.
            autoscaledPoolOptions: { desiredConcurrency: 1, maxConcurrency: 1 },
            requestHandler: async () => { recorded.push('loaded'); },
            failedRequestHandler: async () => { recorded.push('failed'); },
        });

        try {
            // The hostname never resolves, so a page can only load through a proxy.
            await requestQueue.addRequest({
                url: 'http://proxy-probe.invalid/theirs',
                userData: { proxyOptions: { useApifyProxy: false, proxyUrls: [proxyUrl] } },
            });
            await requestQueue.addRequest({
                url: 'http://proxy-probe.invalid/mine',
                userData: { proxyOptions: { useApifyProxy: false } },
            });
            await crawler.run();
        } finally {
            otherCallersProxy.close();
        }

        expect(recorded).toHaveLength(2);
        expect(seenByOtherCallersProxy).toEqual(['http://proxy-probe.invalid/theirs']);
    }, 180_000);

    // Without incognito pages every caller silently shares the first browser's proxy.
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
