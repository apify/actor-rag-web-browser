import fs from 'node:fs';
import path from 'node:path';

import { Actor } from 'apify';
import { load } from 'cheerio';
import type { CheerioAPI } from 'crawlee';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveGoogleRedirectUrls, scrapeOrganicResults } from '../src/google-search/google-extractors-urls.js';

const { gotScrapingMock } = vi.hoisted(() => ({ gotScrapingMock: vi.fn() }));

vi.mock('crawlee', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    gotScraping: gotScrapingMock,
}));

const resolveUrls = async (urls: string[]) => {
    const results = await resolveGoogleRedirectUrls(urls.map((url) => ({ title: 'title', url })));
    return results.map((result) => result.url);
};

describe('resolving Google redirect urls', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(Actor, 'createProxyConfiguration').mockResolvedValue(undefined);
    });

    it('leaves non-redirect urls untouched without requesting them', async () => {
        const urls = ['https://example.com/page', 'https://example.com/goto?url=abc', 'https://www.google.com/maps', 'https://www.google.de/url?q=abc'];

        expect(await resolveUrls(urls)).toEqual(urls);
        expect(gotScrapingMock).not.toHaveBeenCalled();
    });

    it('resolves redirect urls from the location header without following it', async () => {
        gotScrapingMock.mockResolvedValue({ statusCode: 302, headers: { location: 'https://example.com/dest' } });

        expect(await resolveUrls(['https://www.google.com/goto?url=abc'])).toEqual(['https://example.com/dest']);
        expect(gotScrapingMock).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ url: 'https://www.google.com/goto?url=abc', followRedirect: false }),
        );
    });

    it('drops the result after retries when the response is not a redirect', async () => {
        gotScrapingMock.mockResolvedValue({ statusCode: 403, headers: {} });

        expect(await resolveUrls(['https://www.google.com/goto?url=abc'])).toEqual([]);
        expect(gotScrapingMock).toHaveBeenCalledTimes(3);
    });

    it('recovers on a retry after a request error', async () => {
        gotScrapingMock
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockResolvedValueOnce({ statusCode: 302, headers: { location: 'https://example.com/dest' } });

        expect(await resolveUrls(['https://www.google.com/url?q=abc'])).toEqual(['https://example.com/dest']);
        expect(gotScrapingMock).toHaveBeenCalledTimes(2);
    });

    it('leaves no /goto urls in the results of a SERP', async () => {
        gotScrapingMock.mockImplementation(async ({ url }: { url: string }) => (url.endsWith('resolvable')
            ? { statusCode: 302, headers: { location: 'https://en.wikipedia.org/wiki/TypeScript' } }
            : { statusCode: 403, headers: {} }));
        const html = fs.readFileSync(path.join(__dirname, 'helpers', 'html', 'google-serp-goto.html'), 'utf-8');
        const organicResults = scrapeOrganicResults(load(html) as unknown as CheerioAPI);

        const results = await resolveGoogleRedirectUrls(organicResults);

        expect(results.map(({ title, url }) => ({ title, url }))).toEqual([
            { title: 'Direct result', url: 'https://example.com/direct' },
            { title: 'TypeScript', url: 'https://en.wikipedia.org/wiki/TypeScript' },
        ]);
    });
});
