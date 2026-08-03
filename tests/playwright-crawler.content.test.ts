import type { Server } from 'node:http';

import { MemoryStorage } from '@crawlee/memory-storage';
import { RequestQueue } from 'apify';
import { Configuration, log, PlaywrightCrawler, type PlaywrightCrawlingContext } from 'crawlee';
import { firefox } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { requestHandlerPlaywright } from '../src/request-handler.js';
import type { ContentCrawlerUserData, ContentScraperSettings, Output } from '../src/types.js';
import { createRequest } from '../src/utils.js';
import { startTestServer, stopTestServer } from './helpers/server.js';

describe('Playwright Crawler Content Tests', () => {
    let testServer: Server;
    const testServerPort = 3041;
    const baseUrl = `http://localhost:${testServerPort}`;
    process.env.ACTOR_FULL_NAME = 'apify/rag-web-browser';

    // Start the test server before all tests
    beforeAll(async () => {
        testServer = startTestServer(testServerPort);
    });

    // Stop the test server after all tests
    afterAll(async () => {
        await stopTestServer(testServer);
    });

    /**
     * Scrapes a single URL with the Playwright request handler and returns the results it pushed
     * to the dataset, along with the URLs that failed.
     */
    async function scrapeWithPlaywright(url: string, settings: Partial<ContentScraperSettings> = {}) {
        const results: Output[] = [];
        const failedUrls = new Set<string>();

        // Create memory storage and request queue
        const client = new MemoryStorage({ persistStorage: false });
        const requestQueue = await RequestQueue.open('test-queue', { storageClient: client });

        const crawler = new PlaywrightCrawler({
            requestQueue,
            requestHandler: async (context) => {
                vi.spyOn(context, 'pushData').mockImplementation(async (data) => {
                    results.push(data as Output);
                });
                await requestHandlerPlaywright(context as unknown as PlaywrightCrawlingContext<ContentCrawlerUserData>);
            },
            failedRequestHandler: async ({ request }, error) => {
                log.error(`Request ${request.url} failed with error: ${error.message}`);
                failedUrls.add(request.url);
            },
            // Playwright-specific configuration
            launchContext: {
                launcher: firefox,
                launchOptions: {
                    headless: true,
                },
            },
        }, new Configuration({
            persistStorage: false,
        }));

        const r = createRequest(
            'query',
            {
                url,
                description: 'Test request',
                rank: 1,
                title: 'Test title',
            },
            'responseId',
            {
                debugMode: false,
                outputFormats: ['text'],
                maxHtmlCharsToProcess: 100000,
                dynamicContentWaitSecs: 20,
                ...settings,
            },
            [],
        );

        // Add initial request to the queue
        await requestQueue.addRequest(r);

        await crawler.run();

        return { results, failedUrls };
    }

    it('test basic content extraction with playwright', async () => {
        const { results, failedUrls } = await scrapeWithPlaywright(`${baseUrl}/basic`);

        expect(failedUrls.size).toBe(0);
        expect(results).toHaveLength(1);
        expect(results[0].text).toContain('hello world');
    });

    it('expands clickable elements to extract collapsed content', async () => {
        const { results, failedUrls } = await scrapeWithPlaywright(`${baseUrl}/clickable`, {
            dynamicContentWaitSecs: 2,
        });

        expect(failedUrls.size).toBe(0);
        expect(results).toHaveLength(1);
        expect(results[0].text).toContain('always visible content');
        // The panel content is added to the DOM only after the toggle is clicked
        expect(results[0].text).toContain('collapsed panel content');
        // Links to other pages must not be clicked, i.e. we must stay on the original page
        expect(results[0].text).not.toContain('hello world');
    });

    it('returns content of the original page when clicking navigates away', async () => {
        const { results, failedUrls } = await scrapeWithPlaywright(`${baseUrl}/clickable-js-navigation`, {
            dynamicContentWaitSecs: 2,
        });

        // A navigation triggered by JavaScript cannot be prevented by the selector, so the page is
        // loaded again instead of returning the content of the page it navigated to
        expect(failedUrls.size).toBe(0);
        expect(results).toHaveLength(1);
        expect(results[0].text).toContain('page navigating on click');
        expect(results[0].text).not.toContain('hello world');
    });
});
