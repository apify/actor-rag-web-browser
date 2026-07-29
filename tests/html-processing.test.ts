import { load } from 'cheerio';
import type { CheerioAPI } from 'crawlee';
import { describe, expect, it } from 'vitest';

import { extractTitle } from '../src/website-content-crawler/html-processing.js';

// The `cheerio` version bundled with Crawlee differs from the top-level one, so the types don't match.
const parse = (html: string) => load(html) as unknown as CheerioAPI;

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
