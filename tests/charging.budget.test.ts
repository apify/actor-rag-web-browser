import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MemoryStorage } from '@crawlee/memory-storage';
import { Actor } from 'apify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ContentCrawlerStatus, ContentCrawlerTypes } from '../src/const.js';
import { addContentCrawlRequest, createAndStartContentCrawler, failUnaffordableFetch } from '../src/crawlers.js';
import { createResponsePromise } from '../src/responses.js';
import type { ContentScraperSettings, Output } from '../src/types.js';
import { createRequest } from '../src/utils.js';
import { startTestServer, stopTestServer } from './helpers/server.js';

const BUDGET_USD = 5;

// The SDK reads these when it is imported, so they have to be set before the imports run.
vi.hoisted(() => {
    process.env.ACTOR_FULL_NAME = 'apify/rag-web-browser';
    process.env.ACTOR_MAX_TOTAL_CHARGE_USD = '5';
    process.env.APIFY_ACTOR_PRICING_INFO = JSON.stringify({
        pricingModel: 'PAY_PER_EVENT',
        pricingPerEvent: { actorChargeEvents: { fetch: { eventPriceUsd: 1, eventTitle: 'Page fetch' } } },
    });
    process.env.APIFY_CHARGED_ACTOR_EVENT_COUNTS = '{}';
});

describe('Charging against the run budget', () => {
    let testServer: Server;
    const testServerPort = 3045;
    const baseUrl = `http://localhost:${testServerPort}`;

    beforeAll(async () => {
        testServer = startTestServer(testServerPort);
        // Keep off the shared ./storage, which holds what the other test files left in the default dataset.
        const localDataDirectory = mkdtempSync(path.join(tmpdir(), 'charging-budget-'));
        await Actor.init({ storage: new MemoryStorage({ localDataDirectory, persistStorage: false }) });
    });

    afterAll(async () => {
        await stopTestServer(testServer);
    });

    it('stores only the pages it charged for and stays within the budget', async () => {
        const { crawler, key } = await createAndStartContentCrawler({
            type: ContentCrawlerTypes.CHEERIO,
            crawlerOptions: {
                maxRequestRetries: 0,
                // Run the pages in parallel, so they race for the last of the budget.
                minConcurrency: 20,
                preNavigationHooks: [failUnaffordableFetch(ContentCrawlerTypes.CHEERIO)],
            },
        }, false);

        const responses: Promise<Output[]>[] = [];
        for (let i = 0; i < 20; i++) {
            const responseId = `page${i}`;
            responses.push(createResponsePromise(responseId, 30));
            const request = createRequest(
                'hello world',
                { url: `${baseUrl}/basic?page=${i}`, title: 'Test Page' },
                responseId,
                { debugMode: false, dynamicContentWaitSecs: 0, maxHtmlCharsToProcess: 1e6, outputFormats: ['markdown'] } as ContentScraperSettings,
                {},
            );
            await addContentCrawlRequest(request, responseId, key);
        }
        await crawler!.run();
        await Promise.all(responses);

        // Off the platform the SDK prices every event at $1, whatever the pricing info says.
        const fetchCharges = Actor.getChargingManager().getChargedEventCount('fetch');
        const { items } = await crawler!.getData();
        const contentItems = items.filter((item) => item.crawl.requestStatus === ContentCrawlerStatus.HANDLED);

        expect(contentItems.length).toBeGreaterThan(0);
        expect(contentItems).toHaveLength(fetchCharges);
        expect(fetchCharges).toBeLessThanOrEqual(BUDGET_USD);
    });
});
