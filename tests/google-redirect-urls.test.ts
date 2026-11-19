import fs from 'node:fs';
import path from 'node:path';

import { Actor } from 'apify';
import { load } from 'cheerio';
import type { CheerioAPI } from 'crawlee';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveGoogleRedirectUrls, scrapeOrganicResults } from '../src/google-search/google-extractors-urls.js';

const { sendRequestMock, clientOptions } = vi.hoisted(() => ({ sendRequestMock: vi.fn(), clientOptions: [] as unknown[] }));

vi.mock('@crawlee/impit-client', () => ({
    ImpitHttpClient: class {
        constructor(options: unknown) {
            clientOptions.push(options);
        }

        sendRequest = sendRequestMock;
    },
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
        expect(sendRequestMock).not.toHaveBeenCalled();
    });

    it('resolves redirect urls from the location header without following it', async () => {
        sendRequestMock.mockResolvedValue({ statusCode: 302, headers: { location: 'https://example.com/dest' } });

        expect(await resolveUrls(['https://www.google.com/goto?url=abc'])).toEqual(['https://example.com/dest']);
        expect(sendRequestMock).toHaveBeenCalledWith(
            expect.objectContaining({
                url: 'https://www.google.com/goto?url=abc',
                responseType: 'text',
                followRedirect: false,
                timeout: { request: 5_000 },
            }),
        );
        // Impit controls redirect following on the client, not the individual request.
        expect(clientOptions[0]).toEqual({ browser: 'firefox144', vanillaFallback: true, followRedirects: false });
    });

    it('fails when no result can be resolved instead of returning an empty success', async () => {
        sendRequestMock.mockResolvedValue({ statusCode: 403, headers: {} });

        await expect(resolveUrls(['https://www.google.com/goto?url=abc'])).rejects.toThrow('No Google result URLs could be resolved');
        expect(sendRequestMock).toHaveBeenCalledTimes(3);
    });

    it('keeps the destination of any attempt that succeeds', async () => {
        sendRequestMock
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockResolvedValueOnce({ statusCode: 403, headers: {} })
            .mockResolvedValueOnce({ statusCode: 302, headers: { location: 'https://example.com/dest' } });

        expect(await resolveUrls(['https://www.google.com/goto?url=abc'])).toEqual(['https://example.com/dest']);
        expect(sendRequestMock).toHaveBeenCalledTimes(3);
    });

    it('reads /url destinations from their parameters without requesting Google', async () => {
        const urls = [
            'https://www.google.com/url?q=https://example.com/from-q&sa=U',
            'https://www.google.com/url?url=https%3A%2F%2Fexample.com%2Ffrom-url',
        ];

        expect(await resolveUrls(urls)).toEqual(['https://example.com/from-q', 'https://example.com/from-url']);
        expect(sendRequestMock).not.toHaveBeenCalled();
    });

    it('asks Google when the /url parameter is not a valid url', async () => {
        sendRequestMock.mockResolvedValue({ statusCode: 302, headers: { location: 'https://example.com/dest' } });

        expect(await resolveUrls(['https://www.google.com/url?q=abc', 'https://www.google.com/url?q=https://www.google.com/sorry/index']))
            .toEqual(['https://example.com/dest', 'https://example.com/dest']);
    });

    it('resolves http redirect urls too', async () => {
        sendRequestMock.mockResolvedValue({ statusCode: 302, headers: { location: 'https://example.com/dest' } });

        expect(await resolveUrls(['http://www.google.com/goto?url=abc'])).toEqual(['https://example.com/dest']);
    });

    it('drops the result when the location comes without a redirect status', async () => {
        sendRequestMock.mockResolvedValue({ statusCode: 200, headers: { location: 'https://example.com/dest' } });

        await expect(resolveUrls(['https://www.google.com/goto?url=abc'])).rejects.toThrow('No Google result URLs could be resolved');
    });

    it('drops the result when every redirect leads to a captcha or consent page', async () => {
        sendRequestMock
            .mockResolvedValueOnce({ statusCode: 302, headers: { location: '/sorry/index?continue=abc' } })
            .mockResolvedValueOnce({ statusCode: 302, headers: { location: 'https://consent.google.com/ml?continue=abc' } })
            .mockResolvedValueOnce({ statusCode: 302, headers: { location: 'https://www.google.com/sorry/index' } });

        await expect(resolveUrls(['https://www.google.com/goto?url=abc'])).rejects.toThrow('No Google result URLs could be resolved');
    });

    it('keeps redirects to Google pages that are results', async () => {
        sendRequestMock.mockResolvedValue({ statusCode: 302, headers: { location: 'https://cloud.google.com/pricing' } });

        expect(await resolveUrls(['https://www.google.com/goto?url=abc'])).toEqual(['https://cloud.google.com/pricing']);
    });

    it('preserves partial results when one redirect cannot be resolved', async () => {
        sendRequestMock.mockResolvedValue({ statusCode: 403, headers: {} });

        expect(await resolveUrls(['https://example.com/direct', 'https://www.google.com/goto?url=blocked']))
            .toEqual(['https://example.com/direct']);
    });

    it('allows a genuinely empty result set', async () => {
        expect(await resolveUrls([])).toEqual([]);
        expect(sendRequestMock).not.toHaveBeenCalled();
    });

    it('leaves no /goto urls in the results of a SERP', async () => {
        sendRequestMock.mockImplementation(async ({ url }: { url: string }) => (url.endsWith('resolvable')
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

    it('takes the result heading link instead of an unrelated earlier anchor', () => {
        const $ = load(`<div class="MjjYud">
            <a href="https://0.0.0.6">6</a>
            <a href="/goto?url=opaque"><h3>Actual result</h3></a>
            <div class="VwiC3b">The result description.</div>
        </div>`) as unknown as CheerioAPI;

        expect(scrapeOrganicResults($)).toEqual([
            expect.objectContaining({ title: 'Actual result', url: 'https://www.google.com/goto?url=opaque' }),
        ]);
    });

    it('does not treat unspecified IPv4 destinations as organic sources', () => {
        const $ = load(`<div class="MjjYud"><a href="https://0.0.0.6"><h3>Broken result</h3></a></div>
            <div class="MjjYud"><a href="https://6"><h3>Numeric alias</h3></a></div>
            <div class="MjjYud"><a href="https://8.8.8.8/"><h3>Public IP</h3></a></div>
            <div class="MjjYud"><a href="https://0.example.com/"><h3>Real hostname</h3></a></div>`) as unknown as CheerioAPI;

        expect(scrapeOrganicResults($).map(({ url }) => url)).toEqual(['https://8.8.8.8/', 'https://0.example.com/']);
    });

    it('respects the caller’s content proxy choice when resolving redirects', async () => {
        sendRequestMock.mockResolvedValue({ statusCode: 302, headers: { location: 'https://example.com/dest' } });

        await resolveGoogleRedirectUrls([{ title: 'title', url: 'https://www.google.com/goto?url=opaque' }], { useApifyProxy: false });

        expect(Actor.createProxyConfiguration).toHaveBeenCalledWith({ useApifyProxy: false, checkAccess: false });
    });
});
