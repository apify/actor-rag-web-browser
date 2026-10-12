import { describe, expect, it } from 'vitest';

import { ContentCrawlerStatus } from '../src/const.js';
import { createAndStartSearchCrawler } from '../src/crawlers.js';
import {
    addEmptyResultToResponse,
    addResultToResponse,
    createResponsePromise,
    sendResponseIfFinished,
    startMigration,
} from '../src/responses.js';

const handled = (responseId: string, url: string) => {
    addEmptyResultToResponse(responseId, { url, uniqueKey: url } as never);
    addResultToResponse(responseId, url, {
        crawl: { requestStatus: ContentCrawlerStatus.HANDLED },
        metadata: { url },
        searchResult: { rank: 1 },
    } as never);
};

// A run moves only once, so every outcome of that one move belongs in a single test.
describe('a run that moves to another server', () => {
    it('lets callers finish, keeps what the rest already have, and tells the empty ones to retry', async () => {
        const inTime = createResponsePromise('in-time', 300);
        const partial = createResponsePromise('partial', 300);
        const empty = createResponsePromise('empty', 300);
        const url = 'https://example.com/finished';

        const moved = startMigration(500);
        handled('in-time', url);
        sendResponseIfFinished('in-time');
        handled('partial', url);
        addEmptyResultToResponse('partial', { url: 'https://example.com/pending', uniqueKey: 'pending', userData: { searchResult: { rank: 2 } } } as never);
        await moved;

        await expect(inTime).resolves.toMatchObject([{ metadata: { url } }]);
        await expect(partial).resolves.toMatchObject([
            { metadata: { url } },
            { crawl: { requestStatus: ContentCrawlerStatus.FAILED } },
        ]);
        await expect(empty).rejects.toThrow('Actor had to migrate to another server. Please, retry your request.');
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
