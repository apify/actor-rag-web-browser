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
        expect(gotScrapingMock).toHaveBeenCalledWith(
            expect.objectContaining({ url: 'https://www.google.com/goto?url=abc', followRedirect: false }),
        );
    });

    it('drops the result when no attempt gets a redirect', async () => {
        gotScrapingMock.mockResolvedValue({ statusCode: 403, headers: {} });

        expect(await resolveUrls(['https://www.google.com/goto?url=abc'])).toEqual([]);
        expect(gotScrapingMock).toHaveBeenCalledTimes(3);
    });

    it('keeps the destination of any attempt that succeeds', async () => {
        gotScrapingMock
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockResolvedValueOnce({ statusCode: 403, headers: {} })
            .mockResolvedValueOnce({ statusCode: 302, headers: { location: 'https://example.com/dest' } });

        expect(await resolveUrls(['https://www.google.com/goto?url=abc'])).toEqual(['https://example.com/dest']);
        expect(gotScrapingMock).toHaveBeenCalledTimes(3);
    });

    it('reads /url destinations from their parameters without requesting Google', async () => {
        const urls = [
            'https://www.google.com/url?q=https://example.com/from-q&sa=U',
            'https://www.google.com/url?url=https%3A%2F%2Fexample.com%2Ffrom-url',
        ];

        expect(await resolveUrls(urls)).toEqual(['https://example.com/from-q', 'https://example.com/from-url']);
        expect(gotScrapingMock).not.toHaveBeenCalled();
    });

    it('asks Google when the /url parameter is not a valid url', async () => {
        gotScrapingMock.mockResolvedValue({ statusCode: 302, headers: { location: 'https://example.com/dest' } });

        expect(await resolveUrls(['https://www.google.com/url?q=abc', 'https://www.google.com/url?q=https://www.google.com/sorry/index']))
            .toEqual(['https://example.com/dest', 'https://example.com/dest']);
    });

    it('resolves http redirect urls too', async () => {
        gotScrapingMock.mockResolvedValue({ statusCode: 302, headers: { location: 'https://example.com/dest' } });

        expect(await resolveUrls(['http://www.google.com/goto?url=abc'])).toEqual(['https://example.com/dest']);
    });

    it('drops the result when the location comes without a redirect status', async () => {
        gotScrapingMock.mockResolvedValue({ statusCode: 200, headers: { location: 'https://example.com/dest' } });

        expect(await resolveUrls(['https://www.google.com/goto?url=abc'])).toEqual([]);
    });

    it('drops the result when every redirect leads to a captcha or consent page', async () => {
        gotScrapingMock
            .mockResolvedValueOnce({ statusCode: 302, headers: { location: '/sorry/index?continue=abc' } })
            .mockResolvedValueOnce({ statusCode: 302, headers: { location: 'https://consent.google.com/ml?continue=abc' } })
            .mockResolvedValueOnce({ statusCode: 302, headers: { location: 'https://www.google.com/sorry/index' } });

        expect(await resolveUrls(['https://www.google.com/goto?url=abc'])).toEqual([]);
    });

    it('keeps redirects to Google pages that are results', async () => {
        gotScrapingMock.mockResolvedValue({ statusCode: 302, headers: { location: 'https://cloud.google.com/pricing' } });

        expect(await resolveUrls(['https://www.google.com/goto?url=abc'])).toEqual(['https://cloud.google.com/pricing']);
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
