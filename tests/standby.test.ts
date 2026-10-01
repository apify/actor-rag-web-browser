import type { Server } from 'node:http';

import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';

import { ContentCrawlerStatus } from '../src/const.js';
import { createAndStartContentCrawler, createAndStartSearchCrawler } from '../src/crawlers.js';
import { processStandbyInput } from '../src/input.js';
import { createServer } from '../src/server.js';
import { getImageRequestCount, resetImageRequestCount, startTestServer, stopTestServer } from './helpers/server.js';

describe('Standby RAG tests', () => {
    let browserServer: Server;
    const browserServerPort = 3000;
    let testServer: Server;
    const testServerPort = 3042;
    const baseUrl = `http://localhost:${testServerPort}`;
    process.env.ACTOR_FULL_NAME = 'apify/rag-web-browser';

    beforeAll(async () => {
        testServer = startTestServer(testServerPort);

        const {
            searchCrawlerOptions,
            contentCrawlerOptions,
        } = await processStandbyInput({
            scrapingTool: 'raw-http',
        });

        const startCrawlers = async () => {
            const promises: Promise<unknown>[] = [];
            promises.push(createAndStartSearchCrawler(searchCrawlerOptions));
            for (const settings of contentCrawlerOptions) {
                promises.push(createAndStartContentCrawler(settings));
            }
            await Promise.all(promises);
        };

        const app = createServer();
        browserServer = app.listen(browserServerPort, startCrawlers);
    });

    afterAll(async () => {
        browserServer.close();
        await stopTestServer(testServer);
    });

    it('basic standby request cheerio with url', async () => {
        const response = await fetch(`http://localhost:${browserServerPort}/search?query=${baseUrl}/basic`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
        expect(data[0].metadata.title).toBe('Test Page');
        expect(data[0].metadata.url).toBe(`${baseUrl}/basic`);
        expect(data[0].crawl.httpStatusCode).toBe(200);
        expect(data[0].markdown).toContain('hello world');
    });

    it('basic standby request playwright with url', async () => {
        const response = await fetch(`http://localhost:${browserServerPort}/search?query=${baseUrl}/basic&scrapingTool=browser-playwright`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
        expect(data[0].metadata.title).toBe('Test Page');
        expect(data[0].metadata.url).toBe(`${baseUrl}/basic`);
        expect(data[0].crawl.httpStatusCode).toBe(200);
        expect(data[0].markdown).toContain('hello world');
    });

    it('standby request with a media file URL is skipped without downloading it', async () => {
        resetImageRequestCount();

        const response = await fetch(`http://localhost:${browserServerPort}/search?query=${baseUrl}/image.png`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.length).toBe(1);
        expect(data[0].metadata.url).toBe(`${baseUrl}/image.png`);
        expect(data[0].crawl.requestStatus).toBe(ContentCrawlerStatus.FAILED);
        expect(data[0].crawl.httpStatusMessage).toBe('Skipped media file');
        expect(getImageRequestCount()).toBe(0);
    });

    it('standby request playwright with a media file URL is skipped without downloading it', async () => {
        resetImageRequestCount();

        const response = await fetch(`http://localhost:${browserServerPort}/search?query=${baseUrl}/image.png&scrapingTool=browser-playwright`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.length).toBe(1);
        expect(data[0].crawl.httpStatusMessage).toBe('Skipped media file');
        expect(getImageRequestCount()).toBe(0);
    });

    it.each([
        { scrapingTool: 'raw-http', htmlTransformer: 'none' },
        { scrapingTool: 'raw-http', htmlTransformer: 'readableText' },
        { scrapingTool: 'browser-playwright', htmlTransformer: 'none' },
        { scrapingTool: 'browser-playwright', htmlTransformer: 'readableText' },
    ])('standby request $scrapingTool with $htmlTransformer resolves links against the base URL', async (params) => {
        // A URL of its own for each case, so that the browser doesn't revalidate the page in its cache.
        const pageUrl = `${baseUrl}/with-base?case=${params.scrapingTool}-${params.htmlTransformer}`;
        const query = new URLSearchParams({ query: pageUrl, ...params });
        const response = await fetch(`http://localhost:${browserServerPort}/search?${query}`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data[0].metadata.url).toBe(pageUrl);
        expect(data[0].metadata.canonicalUrl).toBe('https://cdn.example.org/sub/canonical-page');
        expect(data[0].markdown).toContain('[relative link](https://cdn.example.org/sub/article)');
        expect(data[0].markdown).toContain(`[in-page anchor](${pageUrl}#section)`);
        // Readability adds the title as a heading, which tells it has extracted the content.
        expect(data[0].markdown.startsWith('# Test Page With Base')).toBe(params.htmlTransformer === 'readableText');
    });

    it('standby request with readableText resolves links against the URL redirected to', async () => {
        const query = new URLSearchParams({ query: `${baseUrl}/redirect/page`, htmlTransformer: 'readableText' });
        const response = await fetch(`http://localhost:${browserServerPort}/search?${query}`);
        const data = await response.json();

        const pageUrl = `${baseUrl}/redirected/page`;
        expect(response.status).toBe(200);
        expect(data[0].metadata.url).toBe(pageUrl);
        expect(data[0].markdown).toContain(`[relative link](${baseUrl}/redirected/article)`);
        expect(data[0].markdown).toContain(`[in-page anchor](${pageUrl}#section)`);
        expect(data[0].markdown.startsWith('# Test Page With Base')).toBe(true);
    });

    it('standby request playwright does not download media files of the page', async () => {
        resetImageRequestCount();

        const response = await fetch(`http://localhost:${browserServerPort}/search?query=${baseUrl}/with-image&scrapingTool=browser-playwright`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data[0].crawl.httpStatusCode).toBe(200);
        expect(data[0].markdown).toContain('hello world');
        expect(getImageRequestCount()).toBe(0);
    });
});
