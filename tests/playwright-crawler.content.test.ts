import type { Server } from 'node:http';

import { MemoryStorage } from '@crawlee/memory-storage';
import { RequestQueue } from 'apify';
import { Configuration, log, PlaywrightCrawler, type PlaywrightCrawlingContext } from 'crawlee';
import { firefox } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { requestHandlerPlaywright } from '../src/request-handler.js';
import type { ContentCrawlerUserData } from '../src/types.js';
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

    it('test basic content extraction with playwright', async () => {
        const failedUrls = new Set<string>();
        const successUrls = new Set<string>();

        // Create memory storage and request queue
        const client = new MemoryStorage({ persistStorage: false });
        const requestQueue = await RequestQueue.open('test-queue', { storageClient: client });

        const crawler = new PlaywrightCrawler({
            requestQueue,
            requestHandler: async (context) => {
                const pushDataSpy = vi.spyOn(context, 'pushData').mockResolvedValue(undefined);
                await requestHandlerPlaywright(context as unknown as PlaywrightCrawlingContext<ContentCrawlerUserData>);

                expect(pushDataSpy).toHaveBeenCalledTimes(1);
                expect(pushDataSpy).toHaveBeenCalledWith(expect.objectContaining({
                    text: expect.stringContaining('hello world'),
                }));
                successUrls.add(context.request.url);
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
                url: `${baseUrl}/basic`,
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
            },
            [],
        );

        // Add initial request to the queue
        await requestQueue.addRequest(r);

        await crawler.run();

        expect(failedUrls.size).toBe(0);
        expect(successUrls.size).toBe(1);
    });
});
