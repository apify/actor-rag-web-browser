import { load } from 'cheerio';
import type { CheerioAPI } from 'crawlee';
import { describe, expect, it } from 'vitest';

import { extractLinks, extractTitle } from '../src/website-content-crawler/html-processing.js';

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

describe('extractLinks', () => {
    const BASE = 'https://example.com/blog/post';

    it('resolves relative hrefs to absolute URLs against the base', () => {
        const $ = parse(`<body>
            <a href="/docs">a</a>
            <a href="../about">b</a>
            <a href="page.html?x=1#frag">c</a>
            <a href="https://other.example.org/x">d</a>
        </body>`);
        expect(extractLinks($, BASE)).toEqual([
            'https://example.com/docs',
            'https://example.com/about',
            'https://example.com/blog/page.html?x=1#frag',
            'https://other.example.org/x',
        ]);
    });

    it('de-duplicates while preserving first-appearance order', () => {
        const $ = parse(`<body>
            <a href="/b">b</a>
            <a href="/a">a1</a>
            <a href="https://example.com/b">b again</a>
            <a href="/a">a2</a>
        </body>`);
        expect(extractLinks($, BASE)).toEqual(['https://example.com/b', 'https://example.com/a']);
    });

    it('drops non-HTTP(S) schemes and bare same-page anchors', () => {
        const $ = parse(`<body>
            <a href="mailto:hi@example.com">mail</a>
            <a href="tel:+123">tel</a>
            <a href="javascript:void(0)">js</a>
            <a href="#section">anchor</a>
            <a href="#">top</a>
            <a href="ftp://example.com/f">ftp</a>
            <a href="/real">real</a>
        </body>`);
        expect(extractLinks($, BASE)).toEqual(['https://example.com/real']);
    });

    it('ignores empty and unparseable hrefs and returns [] when there are no links', () => {
        expect(extractLinks(parse('<body><a href="">x</a><a href="   ">y</a></body>'), BASE)).toEqual([]);
        expect(extractLinks(parse('<body><a href="http://[::1">bad</a></body>'), BASE)).toEqual([]);
        expect(extractLinks(parse('<body><p>no links here</p></body>'), BASE)).toEqual([]);
    });
});
