import type { Server } from 'node:http';

import type { CheerioCrawlerOptions } from 'crawlee';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentCrawlerStatus, ContentCrawlerTypes } from '../src/const.js';
import {
    addContentCrawlRequest,
    addSearchRequest,
    createAndStartContentCrawler,
    createAndStartSearchCrawler,
} from '../src/crawlers.js';
import { processStandbyInput } from '../src/input.js';
import { createResponsePromise } from '../src/responses.js';
import { createServer } from '../src/server.js';
import type { ContentScraperSettings, SearchCrawlerUserData } from '../src/types.js';
import { createRequest, createSearchRequest } from '../src/utils.js';
import { startTestServer, stopTestServer } from './helpers/server.js';

const charging = vi.hoisted(() => ({
    chargeSearch: vi.fn().mockResolvedValue(undefined),
    chargeFetch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/charging.js', () => charging);

describe('Charging from standby requests', () => {
    // The Actor's own search crawler routes through Apify Proxy, which cannot reach the test server.
    const searchCrawlerOptions: CheerioCrawlerOptions = {
        keepAlive: true,
        maxRequestRetries: 0,
        autoscaledPoolOptions: { desiredConcurrency: 1 },
    };
    let searchCrawler: Awaited<ReturnType<typeof createAndStartSearchCrawler>>['crawler'];
    let contentCrawler: Awaited<ReturnType<typeof createAndStartContentCrawler>>['crawler'];
    let contentCrawlerKey: string;
    let standbyServer: Server;
    const standbyServerPort = 3001;
    const standbyUrl = `http://localhost:${standbyServerPort}`;
    let testServer: Server;
    const testServerPort = 3043;
    const baseUrl = `http://localhost:${testServerPort}`;
    process.env.ACTOR_FULL_NAME = 'apify/rag-web-browser';

    beforeAll(async () => {
        testServer = startTestServer(testServerPort);

        const { contentCrawlerOptions } = await processStandbyInput({ scrapingTool: 'raw-http' });

        const [search, ...contentCrawlers] = await Promise.all([
            createAndStartSearchCrawler(searchCrawlerOptions),
            ...contentCrawlerOptions.map(async (settings) => ({
                type: settings.type,
                ...await createAndStartContentCrawler(settings),
            })),
        ]);
        searchCrawler = search.crawler;

        const cheerioCrawler = contentCrawlers.find(({ type }) => type === ContentCrawlerTypes.CHEERIO)!;
        contentCrawler = cheerioCrawler.crawler;
        contentCrawlerKey = cheerioCrawler.key;

        standbyServer = await new Promise<Server>((resolve) => {
            const server = createServer().listen(standbyServerPort, () => resolve(server));
        });
    });

    afterAll(async () => {
        standbyServer.close();
        await stopTestServer(testServer);
    });

    beforeEach(() => {
        vi.clearAllMocks();
        charging.chargeFetch.mockResolvedValue(undefined);
        charging.chargeSearch.mockResolvedValue(undefined);
    });

    it.each([
        ['raw-http', ContentCrawlerTypes.CHEERIO],
        ['browser-playwright', ContentCrawlerTypes.PLAYWRIGHT],
    ])('charges one fetch per page scraped with %s, attributed to the calling request', async (tool, crawlerType) => {
        const response = await fetch(`${standbyUrl}/search?query=${baseUrl}/basic&scrapingTool=${tool}`, {
            headers: { 'x-actor-request-id': 'request123' },
        });

        expect(response.status).toBe(200);
        // Keying the charge on the request being charged for is what keeps a retry from billing twice.
        const [result] = await response.json();
        expect(charging.chargeFetch).toHaveBeenCalledExactlyOnceWith(crawlerType, {
            actorRequestId: 'request123',
            idempotencyKey: result.crawl.uniqueKey,
        });
    });

    // Deliberate: a media file is skipped without being downloaded but still counts as a fetch, the same
    // as in URL to Markdown, whose charging this shares. Keep it in sync with the pricing grid.
    it('charges for a media file that is skipped without being downloaded', async () => {
        const response = await fetch(`${standbyUrl}/search?query=${baseUrl}/image.png`);

        expect(response.status).toBe(200);
        const [result] = await response.json();
        expect(result.crawl.httpStatusMessage).toBe('Skipped media file');
        expect(charging.chargeFetch).toHaveBeenCalledExactlyOnceWith(ContentCrawlerTypes.CHEERIO, {
            actorRequestId: undefined,
            idempotencyKey: result.crawl.uniqueKey,
        });
    });

    // Standing in for the real case, where Crawlee's handler timeout fires while the charge is in
    // flight: a charge has gone out, its outcome is unknown, and the handler is retried anyway.
    it('does not send a second charge when the handler is retried after one went out', async () => {
        const retriesBefore = contentCrawler!.stats.state.requestsRetries;
        charging.chargeFetch.mockRejectedValueOnce(new Error('handler failed right after charging'));

        const response = await fetch(`${standbyUrl}/search?query=${baseUrl}/basic`);

        expect(response.status).toBe(200);
        expect(contentCrawler!.stats.state.requestsRetries).toBe(retriesBefore + 1);
        expect(charging.chargeFetch).toHaveBeenCalledOnce();
    });

    // A search answers with several pages on one response. Whichever page finishes last completes the
    // response, so every other page's charge has to be in before that - its request ID dies with the
    // response and the platform then refuses the charge.
    it('holds back the response until every page of a multi-page result has been charged for', async () => {
        const responseId = 'multiPage123';
        let chargesSettled = 0;
        charging.chargeFetch.mockImplementation(async () => {
            await new Promise((resolve) => { setTimeout(resolve, 200); });
            chargesSettled++;
        });

        const results = createResponsePromise(responseId, 30);
        for (const path of ['/basic', '/with-image', '/clickable']) {
            const request = createRequest(
                'hello world',
                { url: `${baseUrl}${path}`, title: 'Test Page' },
                responseId,
                { debugMode: false, dynamicContentWaitSecs: 0, maxHtmlCharsToProcess: 1e6, outputFormats: ['markdown'] } as ContentScraperSettings,
                null,
                'request123',
            );
            await addContentCrawlRequest(request, responseId, contentCrawlerKey);
        }

        expect(await results).toHaveLength(3);
        expect(chargesSettled).toBe(3);
    });

    it('does not charge for a page that fails to load', async () => {
        const response = await fetch(`${standbyUrl}/search?query=${baseUrl}/binary`);

        expect(response.status).toBe(200);
        expect((await response.json())[0].crawl.requestStatus).toBe(ContentCrawlerStatus.FAILED);
        expect(charging.chargeFetch).not.toHaveBeenCalled();
    });

    it('does not charge for a search when the query is a URL', async () => {
        const response = await fetch(`${standbyUrl}/search?query=${baseUrl}/basic`);

        expect(response.status).toBe(200);
        expect(charging.chargeSearch).not.toHaveBeenCalled();
    });

    // The request ID is only accepted while its HTTP request is in flight, so a charge that lands
    // after the response has been sent is rejected by the platform and the caller is never billed.
    it('holds back the response until the fetch has been charged for', async () => {
        let releaseCharge: () => void;
        charging.chargeFetch.mockReturnValue(new Promise<void>((resolve) => { releaseCharge = resolve; }));

        let responded = false;
        const responsePromise = fetch(`${standbyUrl}/search?query=${baseUrl}/basic`)
            .then((response) => { responded = true; return response; });

        await vi.waitFor(() => expect(charging.chargeFetch).toHaveBeenCalledOnce());
        expect(responded).toBe(false);

        releaseCharge!();
        expect((await responsePromise).status).toBe(200);
    });

    /**
     * Submits a search request straight to the search crawler, pointed at a stand-in result page on the
     * test server so that the crawler can be exercised without reaching Google.
     */
    async function submitSearch(path: string, userData: Partial<SearchCrawlerUserData> = {}) {
        const request = createSearchRequest({
            query: 'hello world',
            maxResults: 1,
            responseId: 'response123',
            contentCrawlerKey,
            contentScraperSettings: {
                debugMode: false,
                dynamicContentWaitSecs: 0,
                maxHtmlCharsToProcess: 1e6,
                outputFormats: ['markdown'],
            },
            actorRequestId: 'request123',
            ...userData,
        }, undefined);
        request.url = `${baseUrl}${path}`;
        await addSearchRequest(request, searchCrawlerOptions);
        return request.uniqueKey!;
    }

    it('charges one search once Google has answered, attributed to the calling request', async () => {
        const uniqueKey = await submitSearch('/serp');

        // The stand-in result page links to a page of its own, so a fetch means the search is done with.
        await vi.waitFor(() => expect(charging.chargeFetch).toHaveBeenCalled(), { timeout: 10_000 });
        expect(charging.chargeSearch).toHaveBeenCalledExactlyOnceWith({ actorRequestId: 'request123', idempotencyKey: uniqueKey });
    });

    it('does not charge for a search that Google refuses with an empty page', async () => {
        const finishedBefore = searchCrawler!.stats.state.requestsFinished;

        await submitSearch('/serp-empty');

        await vi.waitFor(() => expect(searchCrawler!.stats.state.requestsFinished).toBe(finishedBefore + 1), { timeout: 10_000 });
        expect(charging.chargeSearch).not.toHaveBeenCalled();
    });

    it('does not charge for a search that Google never answers', async () => {
        await submitSearch('/serp-error');

        await vi.waitFor(() => expect(searchCrawler!.stats.state.requestsFailed).toBe(1), { timeout: 10_000 });
        expect(charging.chargeSearch).not.toHaveBeenCalled();
    });

    // The flag is what a request carries after a charge for it has already gone out.
    it('does not charge again for a query already marked as charged', async () => {
        await submitSearch('/serp', { isSearchChargeAttempted: true });

        await vi.waitFor(() => expect(charging.chargeFetch).toHaveBeenCalled(), { timeout: 10_000 });
        expect(charging.chargeSearch).not.toHaveBeenCalled();
    });
});
