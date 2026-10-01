import { load } from 'cheerio';
import type { CheerioAPI } from 'crawlee';
import { describe, expect, it } from 'vitest';

import type { ContentScraperSettings } from '../src/types.js';
import { extractTitle, getDocumentBaseUrl, processHtml } from '../src/website-content-crawler/html-processing.js';

// The `cheerio` version bundled with Crawlee differs from the top-level one, so the types don't match.
const parse = (html: string) => load(html) as unknown as CheerioAPI;
const parseLikeCheerioCrawler = (html: string) => load(html, { xml: { xmlMode: false } }) as unknown as CheerioAPI;

describe('extractTitle', () => {
    it('should extract the title from somewhere else if not in head', () => {
        const $ = parse(`<html>
            <head></head>
            <body>
                <div class="content">The part with the content.</div>
                <title>Title in body</title>
            </body>
        </html>`);
        expect(extractTitle($)).toBe('Title in body');
    });

    it('should ignore titles in SVGs anywhere in the html', () => {
        const $ = parse(`<html>
            <head><svg><title>Title in head svg</title></svg></head>
            <body>
                <div class="content">The part with the content.</div>
                <svg><title>Title in body svg</title></svg>
            </body>
        </html>`);
        expect(extractTitle($)).toBe('');
    });

    it('should ignore titles in .crawlee-iframe-replacement anywhere in the html', () => {
        const $ = parse(`<html>
            <head><div class="crawlee-iframe-replacement"><title>Title in head</title></div></head>
            <body>
                <div class="crawlee-iframe-replacement"><title>Title in .crawlee-iframe-replacement</title></div>
            </body>
        </html>`);
        expect(extractTitle($)).toBe('');
    });

    it('should trim surrounding whitespace', () => {
        const $ = parse('<html><head><title>\n   Test Title  \n</title></head><body></body></html>');
        expect(extractTitle($)).toBe('Test Title');
    });
});

describe.each([
    { parser: 'parse5', parseHtml: parse },
    // What `CheerioCrawler` parses with, unlike `PlaywrightCrawler`.
    { parser: 'htmlparser2', parseHtml: parseLikeCheerioCrawler },
])('getDocumentBaseUrl with $parser', ({ parseHtml }) => {
    const PAGE_URL = 'https://example.com/a/b';

    it.each([
        { name: 'in a template', html: '<template><base href="/template/"></template>' },
        { name: 'in a noscript', html: '<noscript><base href="/noscript/"></noscript>' },
        { name: 'in an SVG', html: '<svg><base href="/svg/"></base></svg>' },
        { name: 'in an iframe', html: '<div class="crawlee-iframe-replacement"><base href="/iframe/"></div>' },
        { name: 'with a javascript: URL', html: '<base href="javascript:void(0)">' },
    ])('should ignore a base $name, which a browser does not apply', ({ html }) => {
        const $ = parseHtml(`<html><head></head><body>${html}<a href="x">x</a></body></html>`);
        expect(getDocumentBaseUrl($, PAGE_URL)).toBe(PAGE_URL);
    });
});

describe('processHtml', () => {
    it('should not apply a relative base twice', async () => {
        // Enough text for Readability to extract the content, rather than keep the HTML as it is.
        const paragraphs = `<p>${'Some readable text. '.repeat(20)}</p>`.repeat(8);
        // htmlparser2 doesn't add the `<body>` a page leaves out, so the whole page, `<base>` included, is processed.
        const $ = parseLikeCheerioCrawler(`<html><head><base href="sub/"></head>
            <article><a href="article">a</a>${paragraphs}</article></html>`);
        const settings = { htmlTransformer: 'readableText' } as ContentScraperSettings;

        const html = await processHtml($('html').html(), getDocumentBaseUrl($, 'https://example.com/a/b'), settings, $);
        expect(html).toContain('id="readability-content"');
        expect(html).toContain('href="https://example.com/a/sub/article"');
    });
});
