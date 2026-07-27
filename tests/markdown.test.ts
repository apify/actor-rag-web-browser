import { log } from 'apify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { htmlToMarkdown } from '../src/website-content-crawler/markdown.js';

// The query string is part of the base on purpose: it has to survive a fragment-only href.
const PAGE_URL = 'https://example.com/a/b?q=1';

const TABLE = '<table><tr><th>a</th></tr><tr><td>1</td></tr></table>';

// Enough padding to push a document over GFM_MAX_HTML_LENGTH.
const PADDING = `<p>${'x'.repeat(100_001)}</p>`;

describe('htmlToMarkdown', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        { name: 'root-relative', href: '/docs', resolved: 'https://example.com/docs' },
        { name: 'path-relative', href: 'sub/page', resolved: 'https://example.com/a/sub/page' },
        { name: 'fragment-only', href: '#sec', resolved: 'https://example.com/a/b?q=1#sec' },
        { name: 'already absolute', href: 'https://other.com/x', resolved: 'https://other.com/x' },
        { name: 'non-HTTP scheme', href: 'mailto:a@b.c', resolved: 'mailto:a@b.c' },
    ])('should resolve a $name href against the page URL', ({ href, resolved }) => {
        expect(htmlToMarkdown(`<a href="${href}">text</a>`, PAGE_URL)).toBe(`[text](${resolved})`);
    });

    it('should keep hrefs relative and stay quiet when no page URL is given', () => {
        const warning = vi.spyOn(log, 'warning');

        expect(htmlToMarkdown('<a href="/docs">text</a>')).toBe('[text](/docs)');
        expect(warning).not.toHaveBeenCalled();
    });

    it('should keep the href and warn when it cannot be resolved', () => {
        const warning = vi.spyOn(log, 'warning').mockImplementation(() => undefined);

        expect(htmlToMarkdown('<a href="http://[">text</a>', PAGE_URL)).toBe('[text](http://[)');
        expect(warning).toHaveBeenCalledOnce();
    });

    it('should keep the title of a resolved link and escape parentheses in its href', () => {
        expect(htmlToMarkdown('<a href="/a(b)c" title="My title">text</a>', PAGE_URL))
            .toBe('[text](https://example.com/a\\(b\\)c "My title")');
    });

    it('should return null for empty html', () => {
        expect(htmlToMarkdown('', PAGE_URL)).toBeNull();
    });

    it('should convert tables using GitHub Flavored Markdown', () => {
        expect(htmlToMarkdown(TABLE, PAGE_URL)).toContain('| --- |');
    });

    it('should skip GFM but still resolve links above the size limit', () => {
        const markdown = htmlToMarkdown(`<a href="/docs">text</a>${TABLE}${PADDING}`, PAGE_URL);

        expect(markdown).toContain('[text](https://example.com/docs)');
        expect(markdown).not.toContain('| --- |');
    });
});
