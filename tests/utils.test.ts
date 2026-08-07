import { describe, expect, it } from 'vitest';

import type { ContentScraperSettings } from '../src/types.js';
import { createRequest, createSearchRequest, interpretAsUrl, parseParameters } from '../src/utils.js';

const contentScraperSettings: ContentScraperSettings = {
    debugMode: false,
    dynamicContentWaitSecs: 1,
    maxHtmlCharsToProcess: 1000,
    outputFormats: ['markdown'],
    requestTimeoutSecs: 7,
    maxRequestRetries: 3,
};

describe('interpretAsUrl', () => {
    it('should return null for empty input', () => {
        expect(interpretAsUrl('')).toBeNull();
    });

    it('should return null for invalid URL', () => {
        expect(interpretAsUrl('invalid-url')).toBeNull();
    });

    it('should return the URL for valid HTTP URL', () => {
        expect(interpretAsUrl('http://example.com')).toBe('http://example.com/');
    });

    it('should return the URL for valid HTTPS URL', () => {
        expect(interpretAsUrl('https://example.com')).toBe('https://example.com/');
    });

    it('should decode and return the URL for encoded URL', () => {
        expect(interpretAsUrl('https%3A%2F%2Fexample.com')).toBe('https://example.com/');
    });

    it('should return null for non-HTTP/HTTPS protocols', () => {
        expect(interpretAsUrl('ftp://example.com')).toBeNull();
    });

    it('should handle multiple decoding attempts', () => {
        expect(interpretAsUrl('https%253A%252F%252Fexample.com')).toBe('https://example.com/');
    });
});

describe('request retries', () => {
    it('takes the content retry count from the scraper settings', () => {
        expect(createRequest('q', { url: 'https://example.com' }, 'rid', contentScraperSettings).maxRetries).toBe(3);
    });

    it('takes the search retry count from the user data', () => {
        const request = createSearchRequest({
            query: 'q',
            responseId: 'rid',
            maxResults: 1,
            contentCrawlerKey: 'key',
            contentScraperSettings,
            serpMaxRetries: 4,
        }, {});

        expect(request.maxRetries).toBe(4);
        expect(request.userData?.serpMaxRetries).toBe(4);
    });
});

describe('parseParameters', () => {
    it('drops parameters that only apply to the crawlers started with the Actor', () => {
        const proxyConfiguration = encodeURIComponent('{"useApifyProxy":true}');

        expect(parseParameters(`?query=x&desiredConcurrency=17&proxyConfiguration=${proxyConfiguration}`))
            .toEqual({ query: 'x' });
    });
});
