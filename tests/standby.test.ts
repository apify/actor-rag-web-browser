import type { Server } from 'node:http';
import {
    describe,
    it,
    beforeAll,
    afterAll,
    expect,
} from 'vitest';

import { createAndStartContentCrawler, createAndStartSearchCrawler } from '../src/crawlers';
import { processStandbyInput } from '../src/input';
import { createServer } from '../src/server';
import { startTestServer, stopTestServer } from './helpers/server';

describe('Standby RAG tests', () => {
    let browserServer: Server;
    const browserServerPort = 3000;
    let testServer: Server;
    const testServerPort = 3042;
    const baseUrl = `http://localhost:${testServerPort}`;
    process.env.ACTOR_PATH_IN_DOCKER_CONTEXT = 'actors/apify_rag-web-browser';

    beforeAll(async () => {
        testServer = startTestServer(testServerPort);

        const {
            searchCrawlerOptions,
            contentCrawlerOptions,
            selectedMiniActor,
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

        const app = createServer(selectedMiniActor!);
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
});
