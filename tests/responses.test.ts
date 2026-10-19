import { describe, expect, it } from 'vitest';

import { ContentCrawlerStatus, SHUTDOWN_DRAIN_MILLIS } from '../src/const.js';
import { createAndStartSearchCrawler } from '../src/crawlers.js';
import {
    addEmptyResultToResponse,
    addResultToResponse,
    createResponsePromise,
    handleShutdown,
    sendResponseIfFinished,
} from '../src/responses.js';

const handled = (responseId: string, url: string) => {
    addEmptyResultToResponse(responseId, { url, uniqueKey: url } as never);
    addResultToResponse(responseId, url, {
        crawl: { requestStatus: ContentCrawlerStatus.HANDLED },
        metadata: { url },
        searchResult: { rank: 1 },
    } as never);
};

// A run shuts down only once, so every outcome of that one shutdown belongs in a single test.
describe('a run that shuts down', () => {
    it('lets callers finish, keeps what the rest already have, and tells the empty ones to retry', async () => {
        // Crawlee's `sleep` runs on `node:timers/promises`, which fake timers do not reach.
        SHUTDOWN_DRAIN_MILLIS.aborting = 500;
        const inTime = createResponsePromise('in-time', 300);
        const partial = createResponsePromise('partial', 300);
        const empty = createResponsePromise('empty', 300);
        const url = 'https://example.com/finished';

        const shutdown = handleShutdown('aborting');
        handled('in-time', url);
        sendResponseIfFinished('in-time');
        handled('partial', url);
        addEmptyResultToResponse('partial', { url: 'https://example.com/pending', uniqueKey: 'pending', userData: { searchResult: { rank: 2 } } } as never);
        await shutdown;

        await expect(inTime).resolves.toMatchObject([{ metadata: { url } }]);
        await expect(partial).resolves.toMatchObject([
            { metadata: { url } },
            { crawl: { requestStatus: ContentCrawlerStatus.FAILED } },
        ]);
        await expect(empty).rejects.toThrow('The run is shutting down, please retry the request.');
    });
});

describe('a search that fails', () => {
    it('tells the caller why, instead of leaving them to wait out their own timeout', async () => {
        const waiting = createResponsePromise('search-failed', 300);
        const { crawler } = await createAndStartSearchCrawler({}, false);
        const { failedRequestHandler } = crawler as unknown as {
            failedRequestHandler: (context: unknown, err: Error) => Promise<void>;
        };

        await failedRequestHandler(
            // The request's own key is not the response's: the response is found by `responseId`.
            { request: { url: 'https://www.google.com/search?q=x', uniqueKey: 'some-other-key', userData: { responseId: 'search-failed' } } },
            new Error('Google refused the request'),
        );

        await expect(waiting).rejects.toThrow('Google refused the request');
    });
});
