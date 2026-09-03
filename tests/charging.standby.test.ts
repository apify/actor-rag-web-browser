import type { Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentCrawlerStatus, ContentCrawlerTypes } from '../src/const.js';
import { createAndStartContentCrawler, createAndStartSearchCrawler } from '../src/crawlers.js';
import { processStandbyInput } from '../src/input.js';
import { createServer } from '../src/server.js';
import { startTestServer, stopTestServer } from './helpers/server.js';

const charging = vi.hoisted(() => ({
    chargeActorStart: vi.fn().mockResolvedValue(undefined),
    chargeSearch: vi.fn().mockResolvedValue(undefined),
    chargeFetch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/charging.js', () => charging);

describe('Charging from standby requests', () => {
    let standbyServer: Server;
    const standbyServerPort = 3001;
    const standbyUrl = `http://localhost:${standbyServerPort}`;
    let testServer: Server;
    const testServerPort = 3043;
    const baseUrl = `http://localhost:${testServerPort}`;
    process.env.ACTOR_FULL_NAME = 'apify/rag-web-browser';

    beforeAll(async () => {
        testServer = startTestServer(testServerPort);

        const { searchCrawlerOptions, contentCrawlerOptions } = await processStandbyInput({ scrapingTool: 'raw-http' });

        const app = createServer();
        standbyServer = app.listen(standbyServerPort, async () => {
            await Promise.all([
                createAndStartSearchCrawler(searchCrawlerOptions),
                ...contentCrawlerOptions.map(async (settings) => createAndStartContentCrawler(settings)),
            ]);
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

    it('charges one fetch per extracted page, attributed to the calling request', async () => {
        const response = await fetch(`${standbyUrl}/search?query=${baseUrl}/basic`, {
            headers: { 'x-actor-request-id': 'request123' },
        });

        expect(response.status).toBe(200);
        expect(charging.chargeFetch).toHaveBeenCalledExactlyOnceWith(ContentCrawlerTypes.CHEERIO, 'request123');
    });

    it('reports the crawler that did the extraction', async () => {
        const response = await fetch(`${standbyUrl}/search?query=${baseUrl}/basic&scrapingTool=browser-playwright`, {
            headers: { 'x-actor-request-id': 'request123' },
        });

        expect(response.status).toBe(200);
        expect(charging.chargeFetch).toHaveBeenCalledExactlyOnceWith(ContentCrawlerTypes.PLAYWRIGHT, 'request123');
    });

    // A media file is skipped without being downloaded, but still counts as a fetch - the same as in
    // URL to Markdown, whose charging this shares. Deliberate, so keep it in sync with the pricing grid.
    it('charges for a media file that is skipped without being downloaded', async () => {
        const response = await fetch(`${standbyUrl}/search?query=${baseUrl}/image.png`);

        expect(response.status).toBe(200);
        expect((await response.json())[0].crawl.httpStatusMessage).toBe('Skipped media file');
        expect(charging.chargeFetch).toHaveBeenCalledExactlyOnceWith(ContentCrawlerTypes.CHEERIO, undefined);
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

    it('charges one search per query that is not a URL, attributed to the calling request', async () => {
        // The charge is awaited before the search crawler starts, so never resolving it keeps this test
        // from reaching the real Google Search.
        charging.chargeSearch.mockReturnValue(new Promise<void>(() => { /* Never settles. */ }));

        const abortController = new AbortController();
        const responsePromise = fetch(`${standbyUrl}/search?query=hello+world`, {
            headers: { 'x-actor-request-id': 'request123' },
            signal: abortController.signal,
        });

        await vi.waitFor(() => expect(charging.chargeSearch).toHaveBeenCalledExactlyOnceWith('request123'));
        expect(charging.chargeFetch).not.toHaveBeenCalled();

        abortController.abort();
        await expect(responsePromise).rejects.toThrow();
    });
});
