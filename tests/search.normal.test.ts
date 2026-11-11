import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentCrawlerTypes } from '../src/const.js';
import { handleSearchNormalMode } from '../src/search.js';
import type { ContentCrawlerOptions, ContentScraperSettings, Input } from '../src/types.js';

const mocks = vi.hoisted(() => ({
    createContent: vi.fn(),
    createSearch: vi.fn(),
    contentRun: vi.fn(),
    searchRun: vi.fn(),
}));

vi.mock('../src/crawlers.js', () => ({
    createAndStartContentCrawler: mocks.createContent,
    createAndStartSearchCrawler: mocks.createSearch,
    addContentCrawlRequest: vi.fn(),
    addSearchRequest: vi.fn(),
}));

process.env.ACTOR_FULL_NAME = 'apify/rag-web-browser';

describe('normal-mode search failure reporting', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const run = async (searchFailed: number, contentFinished: number, contentFailed: number, query = 'a search query') => {
        mocks.createSearch.mockResolvedValue({
            key: 'search',
            crawler: { run: mocks.searchRun, stats: { state: { requestsFinished: searchFailed ? 0 : 1, requestsFailed: searchFailed } } },
        });
        mocks.createContent.mockResolvedValue({
            key: 'cheerio',
            crawler: { run: mocks.contentRun, stats: { state: { requestsFinished: contentFinished, requestsFailed: contentFailed } } },
        });
        return handleSearchNormalMode(
            { query, maxResults: 3, serpMaxRetries: 0, serpProxyGroup: 'GOOGLE_SERP', proxyConfiguration: { useApifyProxy: false } } as unknown as Input,
            {},
            { type: ContentCrawlerTypes.CHEERIO, crawlerOptions: {} } as ContentCrawlerOptions,
            { maxRequestRetries: 0 } as ContentScraperSettings,
        );
    };

    it('fails when the search stage failed instead of reporting an empty success', async () => {
        await expect(run(1, 0, 0)).rejects.toThrow('Google search failed');
        expect(mocks.contentRun).not.toHaveBeenCalled();
    });

    it('fails when every requested content page failed', async () => {
        await expect(run(0, 0, 3)).rejects.toThrow('All requested content pages failed');
    });

    it('preserves partial success and its failed-page count', async () => {
        await expect(run(0, 1, 2)).resolves.toEqual({ requestsFinished: 1, requestsFailed: 2 });
    });

    it('allows a successful search with genuinely no content results', async () => {
        await expect(run(0, 0, 0)).resolves.toEqual({ requestsFinished: 0, requestsFailed: 0 });
    });

    it('does not run a Google search for a direct URL', async () => {
        await expect(run(1, 1, 0, 'https://example.com/page')).resolves.toEqual({ requestsFinished: 1, requestsFailed: 0 });
        expect(mocks.createSearch).not.toHaveBeenCalled();
    });
});
