import { describe, expect, it } from 'vitest';

import { ContentCrawlerStatus } from '../src/const.js';
import { createAndStartSearchCrawler } from '../src/crawlers.js';
import {
    addEmptyResultToResponse,
    addResultToResponse,
    createResponsePromise,
    failAllResponsesOnMigration,
} from '../src/responses.js';

describe('a run that migrates to another server', () => {
    it('tells a caller still waiting to retry, rather than leaving it on its own timeout', async () => {
        const waiting = createResponsePromise('nothing-finished', 300);

        failAllResponsesOnMigration();

        await expect(waiting).rejects.toThrow('Actor had to migrate to another server. Please, retry your request.');
    });

    // This is what makes it safe to answer at once instead of giving the crawl a grace period.
    it('still returns the results a caller already has', async () => {
        const waiting = createResponsePromise('one-page-finished', 300);
        const url = 'https://example.com/finished';
        addEmptyResultToResponse('one-page-finished', { url, uniqueKey: url } as never);
        addResultToResponse('one-page-finished', url, {
            crawl: { requestStatus: ContentCrawlerStatus.HANDLED },
            metadata: { url },
            searchResult: { rank: 1 },
        } as never);

        failAllResponsesOnMigration();

        await expect(waiting).resolves.toMatchObject([{ metadata: { url } }]);
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
