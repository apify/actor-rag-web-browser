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
    getRevalidationCount,
    LLMS_TXT_DOCUMENT,
    MARKDOWN_DOCUMENT,
    PLAIN_TEXT_DOCUMENT,
    resetImageRequestCount,
    startTestServer,
    stopTestServer,
    WINDOWS_1252_DOCUMENT,
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
        async function fetchDocument(path: string, outputFormats = 'markdown') {
            const query = `query=${baseUrl}${path}&scrapingTool=${tool}&outputFormats=${outputFormats}`;
            const response = await fetch(`http://localhost:${browserServerPort}/search?${query}`);
            expect(response.status).toBe(200);
            const [result] = await response.json();
            return result;
        }

        it('returns a Markdown document unchanged, titled by its first heading', async () => {
            const result = await fetchDocument('/agents.md', 'markdown,text,html');

            expect(result.crawl.requestStatus).toBe(ContentCrawlerStatus.HANDLED);
            expect(result.metadata.title).toBe('Agent instructions');
            expect(result.markdown).toBe(MARKDOWN_DOCUMENT);
            expect(result.text).toBe(MARKDOWN_DOCUMENT);
            expect(result.html).toBe(`<pre>\n${MARKDOWN_DOCUMENT}</pre>`);
        });

        it('returns a plain text document unchanged, untitled', async () => {
            const result = await fetchDocument('/notes.txt');

            expect(result.metadata.title).toBe('');
            expect(result.markdown).toBe(PLAIN_TEXT_DOCUMENT);
        });

        it('takes a .md file served as plain text, or without a content type, for Markdown', async () => {
            for (const path of ['/README.md', '/untyped.md']) {
                const result = await fetchDocument(path);

                expect(result.metadata.title).toBe('Agent instructions');
                expect(result.markdown).toBe(MARKDOWN_DOCUMENT);
            }
        });

        it('takes llms.txt for Markdown, served as plain text without a charset', async () => {
            const result = await fetchDocument('/llms.txt');

            expect(result.metadata.title).toBe('Example docs');
            expect(result.markdown).toBe(LLMS_TXT_DOCUMENT);
        });

        it('decodes a document by the charset it declares', async () => {
            const result = await fetchDocument('/windows-1252.txt');

            expect(result.markdown).toBe(WINDOWS_1252_DOCUMENT);
        });

        it('strips the byte order mark of a document', async () => {
            const result = await fetchDocument('/bom.md');

            expect(result.metadata.title).toBe('Agent instructions');
            expect(result.markdown).toBe(MARKDOWN_DOCUMENT);
        });
    });

    // The browser of a standby run keeps its cache, and revalidates a cached document it is asked for again,
    // which leaves the response without a body.
    it('standby request playwright returns a document again from the browser cache', async () => {
        const revalidationsBefore = getRevalidationCount();

        for (let i = 0; i < 2; i++) {
            const response = await fetch(`http://localhost:${browserServerPort}/search?query=${baseUrl}/llms.txt&scrapingTool=browser-playwright`);
            const [result] = await response.json();
            expect(result.markdown).toBe(LLMS_TXT_DOCUMENT);
        }
        expect(getRevalidationCount()).toBeGreaterThan(revalidationsBefore);
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
