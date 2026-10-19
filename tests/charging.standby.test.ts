import type { Server } from 'node:http';

import { type CheerioCrawlerOptions, getRequestId, type RequestOptions } from 'crawlee';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrawlerKind } from '../src/const.js';
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
import type { SearchCrawlerUserData } from '../src/types.js';
import { createRequest, createSearchRequest, randomId } from '../src/utils.js';
import { MARKDOWN_DOCUMENT, startTestServer, stopTestServer } from './helpers/server.js';

const charging = vi.hoisted(() => ({
    canAfford: vi.fn().mockReturnValue(true),
    chargeSearch: vi.fn().mockResolvedValue(undefined),
    chargeFetch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/charging.js', () => charging);

// Every test here stands in for a request served by a Standby run.
vi.mock(import('../src/utils.js'), async (importOriginal) => ({
    ...await importOriginal(),
    isActorStandby: () => true,
}));

describe('Charging from standby requests', () => {
    // The Actor's own search crawler routes through Apify Proxy, which cannot reach the test server.
    const searchCrawlerOptions: CheerioCrawlerOptions = {
        keepAlive: true,
        maxRequestRetries: 0,
        autoscaledPoolOptions: { desiredConcurrency: 1 },
    };
    let searchCrawlerKey: CrawlerKind;
    let searchCrawler: Awaited<ReturnType<typeof createAndStartSearchCrawler>>['crawler'];
    let contentCrawlerKey: CrawlerKind;
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
        searchCrawlerKey = search.key;

        contentCrawlerKey = contentCrawlers.find(({ type }) => type === ContentCrawlerTypes.CHEERIO)!.key;

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

    // Deliberate: a Markdown or plain text document is a page like any other, so it counts as a fetch.
    it('charges for a Markdown document', async () => {
        const response = await fetch(`${standbyUrl}/search?query=${baseUrl}/agents.md`);

        expect(response.status).toBe(200);
        const [result] = await response.json();
        expect(result.markdown).toBe(MARKDOWN_DOCUMENT);
        expect(charging.chargeFetch).toHaveBeenCalledExactlyOnceWith(ContentCrawlerTypes.CHEERIO, {
            actorRequestId: undefined,
            idempotencyKey: result.crawl.uniqueKey,
        });
    });

    // Standing in for the real case, where Crawlee's handler timeout fires while the charge is in
    // flight: a charge has gone out, its outcome is unknown, and the handler is retried anyway.
    it('does not send a second charge when the handler is retried after one went out', async () => {
        charging.chargeFetch.mockRejectedValueOnce(new Error('handler failed right after charging'));

        const response = await fetch(`${standbyUrl}/search?query=${baseUrl}/basic`);

        expect(response.status).toBe(200);
        // The first attempt failed, so a handled page means the handler was retried.
        expect((await response.json())[0].crawl.requestStatus).toBe(ContentCrawlerStatus.HANDLED);
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
                {
                    debugMode: false,
                    dynamicContentWaitSecs: 0,
                    maxHtmlCharsToProcess: 1e6,
                    outputFormats: ['markdown'],
                    maxRequestRetries: 0,
                },
                { useApifyProxy: false },
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
    async function submitSearch(path: string, userData: Partial<SearchCrawlerUserData> = {}, { waiting = true } = {}) {
        const request = createSearchRequest({
            query: 'hello world',
            maxResults: 1,
            responseId: randomId(),
            contentCrawlerKey,
            contentScraperSettings: {
                debugMode: false,
                dynamicContentWaitSecs: 0,
                maxHtmlCharsToProcess: 1e6,
                outputFormats: ['markdown'],
                maxRequestRetries: 0,
            },
            serpMaxRetries: 0,
            contentProxyOptions: { useApifyProxy: false },
            proxyOptions: { useApifyProxy: false },
            actorRequestId: 'request123',
            ...userData,
        });
        request.url = `${baseUrl}${path}`;
        // A search always has a caller waiting on it, unless that caller has gone.
        const response = waiting ? createResponsePromise(request.userData!.responseId, 30) : undefined;
        response?.catch(() => undefined);
        await addSearchRequest(request, searchCrawlerKey);
        return { request, response };
    }

    /**
     * Waits until the search crawler is done with the request, whether it was handled or failed. For a
     * search that never reaches the content crawler, so has no response to wait on.
     */
    async function waitUntilHandled(request: RequestOptions) {
        await vi.waitFor(async () => {
            expect((await searchCrawler!.requestQueue!.getRequest(getRequestId(request.uniqueKey!)))?.handledAt).toBeDefined();
        }, { timeout: 10_000 });
    }

    it('charges one search once Google has answered, attributed to the calling request', async () => {
        const { request, response } = await submitSearch('/serp');

        await response;
        expect(charging.chargeSearch).toHaveBeenCalledExactlyOnceWith({ actorRequestId: 'request123', idempotencyKey: request.uniqueKey });
    });

    it('does not charge for a search whose caller has already gone', async () => {
        const { request } = await submitSearch('/serp', {}, { waiting: false });

        await waitUntilHandled(request);
        expect(charging.chargeSearch).not.toHaveBeenCalled();
        expect(charging.chargeFetch).not.toHaveBeenCalled();
    });

    it('does not charge for a search that Google refuses with an empty page', async () => {
        const { request } = await submitSearch('/serp-empty');

        await waitUntilHandled(request);
        expect(charging.chargeSearch).not.toHaveBeenCalled();
    });

    it('does not charge for a search that Google never answers', async () => {
        const { request } = await submitSearch('/serp-error');

        await waitUntilHandled(request);
        expect(charging.chargeSearch).not.toHaveBeenCalled();
    });

    // The flag is what a request carries after a charge for it has already gone out.
    it('does not charge again for a query already marked as charged', async () => {
        const { response } = await submitSearch('/serp', { isSearchChargeAttempted: true });

        await response;
        expect(charging.chargeSearch).not.toHaveBeenCalled();
    });
});
