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
import {
    getImageRequestCount,
    MARKDOWN_DOCUMENT,
    PLAIN_TEXT_DOCUMENT,
    resetImageRequestCount,
    startTestServer,
    stopTestServer,
} from './helpers/server.js';

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

    // Documents such as agents.md or llms.txt, which AI agents read instructions from, need no conversion.
    // Crawlee's HTTP crawler would reject them, and a browser shows them as plain text, unlike a web page.
    describe.each(['raw-http', 'browser-playwright'])('Markdown and plain text documents with %s', (tool) => {
        // Each fetch gets its own URL: a browser revalidates a repeated one and gets a 304 without a Content-Type.
        let fetchCount = 0;
        async function fetchDocument(path: string, outputFormats = ['markdown', 'text']) {
            const documentUrl = `${baseUrl}${path}?fetch=${fetchCount++}`;
            const query = new URLSearchParams({ query: documentUrl, scrapingTool: tool, outputFormats: JSON.stringify(outputFormats) });
            const response = await fetch(`http://localhost:${browserServerPort}/search?${query}`);
            expect(response.status).toBe(200);
            const [result] = await response.json();
            return result;
        }

        it('returns a Markdown document unchanged', async () => {
            const result = await fetchDocument('/agents.md');

            expect(result.crawl.requestStatus).toBe(ContentCrawlerStatus.HANDLED);
            expect(result.markdown).toBe(MARKDOWN_DOCUMENT);
            expect(result.text).toBe(MARKDOWN_DOCUMENT);
            expect(result.links).toBeUndefined();
        });

        it('returns a plain text document unchanged', async () => {
            const result = await fetchDocument('/llms.txt');

            expect(result.crawl.requestStatus).toBe(ContentCrawlerStatus.HANDLED);
            expect(result.markdown).toBe(PLAIN_TEXT_DOCUMENT);
            expect(result.links).toBeUndefined();
        });

        // A document has no HTML links to extract.
        it.each([
            ['/agents.md', MARKDOWN_DOCUMENT],
            ['/llms.txt', PLAIN_TEXT_DOCUMENT],
        ])('returns an empty `links` array for %s when `links` is selected', async (path, document) => {
            const result = await fetchDocument(path, ['markdown', 'links']);

            expect(result.links).toEqual([]);
            expect(result.markdown).toBe(document);
        });
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
        { htmlTransformer: 'none' },
        { htmlTransformer: 'readableText' },
    ])('standby request with $htmlTransformer resolves links against the base URL', async (params) => {
        const pageUrl = `${baseUrl}/with-base`;
        const query = new URLSearchParams({ query: pageUrl, ...params });
        const response = await fetch(`http://localhost:${browserServerPort}/search?${query}`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data[0].metadata.canonicalUrl).toBe('https://cdn.example.org/sub/canonical-page');
        expect(data[0].markdown).toContain('[relative link](https://cdn.example.org/sub/article)');
        expect(data[0].markdown).toContain(`[in-page anchor](${pageUrl}#section)`);
    });

    it('standby request with the links output format resolves links against the base URL', async () => {
        const query = new URLSearchParams({ query: `${baseUrl}/with-base`, outputFormats: JSON.stringify(['links']) });
        const response = await fetch(`http://localhost:${browserServerPort}/search?${query}`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data[0].links).toEqual([{ url: 'https://cdn.example.org/sub/article', text: 'relative link' }]);
    });

    it('standby request with readableText resolves links against the URL redirected to', async () => {
        const query = new URLSearchParams({ query: `${baseUrl}/redirect/page`, htmlTransformer: 'readableText' });
        const response = await fetch(`http://localhost:${browserServerPort}/search?${query}`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data[0].metadata.url).toBe(`${baseUrl}/redirected/page`);
        expect(data[0].markdown).toContain(`[relative link](${baseUrl}/redirected/article)`);
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
