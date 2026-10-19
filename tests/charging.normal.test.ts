import type { Server } from 'node:http';

import { MemoryStorage } from '@crawlee/memory-storage';
import { Configuration } from 'crawlee';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrawlerKind } from '../src/const.js';
import { ContentCrawlerStatus, ContentCrawlerTypes } from '../src/const.js';
import { addContentCrawlRequest, createAndStartContentCrawler, failUnaffordableFetch } from '../src/crawlers.js';
import { createResponsePromise } from '../src/responses.js';
import type { ContentScraperSettings } from '../src/types.js';
import { createRequest } from '../src/utils.js';
import { startTestServer, stopTestServer } from './helpers/server.js';

const charging = vi.hoisted(() => ({
    canAfford: vi.fn().mockReturnValue(true),
    chargeSearch: vi.fn().mockResolvedValue(undefined),
    chargeFetch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/charging.js', () => charging);

describe('Charging in normal mode', () => {
    let crawler: Awaited<ReturnType<typeof createAndStartContentCrawler>>['crawler'];
    let crawlerKey: CrawlerKind;
    let testServer: Server;
    const testServerPort = 3044;
    const baseUrl = `http://localhost:${testServerPort}`;
    process.env.ACTOR_FULL_NAME = 'apify/rag-web-browser';

    /** Fetches a page and returns the result that its response got, along with how often it was retried. */
    async function fetchPage(responseId: string) {
        const retriesBefore = crawler!.stats.state.requestsRetries;
        const results = createResponsePromise(responseId, 30);
        const request = createRequest(
            'hello world',
            { url: `${baseUrl}/basic`, title: 'Test Page' },
            responseId,
            { debugMode: false, dynamicContentWaitSecs: 0, maxHtmlCharsToProcess: 1e6, outputFormats: ['markdown'] } as ContentScraperSettings,
            null,
        );
        await addContentCrawlRequest(request, responseId, crawlerKey);
        await crawler!.run();

        const [result] = await results;
        return { result, retries: crawler!.stats.state.requestsRetries - retriesBefore };
    }

    beforeAll(async () => {
        // Keep off the shared ./storage, which the other test files purge and write to in parallel.
        Configuration.getGlobalConfig().useStorageClient(new MemoryStorage({ persistStorage: false }));
        Configuration.getGlobalConfig().set('purgeOnStart', false);
        testServer = startTestServer(testServerPort);
        ({ crawler, key: crawlerKey } = await createAndStartContentCrawler({
            type: ContentCrawlerTypes.CHEERIO,
            crawlerOptions: { maxRequestRetries: 1, preNavigationHooks: [failUnaffordableFetch(ContentCrawlerTypes.CHEERIO)] },
        }, false));
    });

    afterAll(async () => {
        await stopTestServer(testServer);
    });

    beforeEach(() => {
        vi.clearAllMocks();
        charging.canAfford.mockReturnValue(true);
    });

    it('fails a page the run cannot pay for before fetching it', async () => {
        charging.canAfford.mockReturnValue(false);

        const { result, retries } = await fetchPage('beforeFetch');

        expect(result.crawl.requestStatus).toBe(ContentCrawlerStatus.FAILED);
        expect(result.crawl.httpStatusMessage).toBe('The run has spent its maximum total charge.');
        expect(charging.chargeFetch).not.toHaveBeenCalled();
        // The budget only ever shrinks, so a retry could not pay for the page either.
        expect(retries).toBe(0);
    });

    // Requests running in parallel all pass the first check while there is budget left for only one of them.
    it('fails a page whose charge the budget no longer covers', async () => {
        charging.canAfford.mockReturnValueOnce(true).mockReturnValueOnce(false);

        const { result, retries } = await fetchPage('atCharge');

        expect(result.crawl.requestStatus).toBe(ContentCrawlerStatus.FAILED);
        expect(result.markdown).toBeUndefined();
        expect(charging.canAfford).toHaveBeenCalledTimes(2);
        expect(charging.chargeFetch).not.toHaveBeenCalled();
        expect(retries).toBe(0);
    });

    it('serves a page the run can pay for', async () => {
        const { result } = await fetchPage('covered');

        expect(result.crawl.requestStatus).toBe(ContentCrawlerStatus.HANDLED);
        expect(result.markdown).toContain('hello world');
    });
});
