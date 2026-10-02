import { log } from 'apify';
import plugin from 'joplin-turndown-plugin-gfm';
import TurndownService, { type Rule } from 'turndown';

const turndownSettings = {
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
} as const;

const GFM_MAX_HTML_LENGTH = 100_000;

function cleanAttribute(attribute: string | null): string {
    return attribute ? attribute.replace(/(\n+\s*)+/g, '\n') : '';
}

function resolveHref(href: string, pageUrl: string, baseUrl: string): string {
    if (!pageUrl) return href;
    try {
        // Unlike browsers, resolve in-page anchors against the page, so that a `<base>` doesn't move them elsewhere.
        // Leading controls and spaces are skipped, like the URL parser does.
        return new URL(href, /^[\0-\x20]*#/.test(href) ? pageUrl : baseUrl).toString();
    } catch {
        log.warning(`Failed to resolve link against the page URL: ${href}`);
        return href;
    }
}

/**
 * Turndown's built-in `inlineLink` rule, extended to resolve relative hrefs against `baseUrl` so that
 * links such as `/docs` remain valid once the markdown is used outside of the source page.
 * @see https://github.com/mixmark-io/turndown/blob/master/src/commonmark-rules.js
 */
const inlineLinkRule = (pageUrl: string, baseUrl: string): Rule => ({
    filter: (node, options) => options.linkStyle === 'inlined'
        && node.nodeName === 'A'
        && Boolean(node.getAttribute('href')),
    replacement: (content, node) => {
        const element = node as HTMLElement;
        const href = resolveHref(element.getAttribute('href')!, pageUrl, baseUrl).replace(/([()])/g, '\\$1');
        const title = cleanAttribute(element.getAttribute('title'));
        return `[${content}](${href}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
    },
});

/**
 * Converts HTML to markdown using Turndown (source: Website Content Crawler).
 * Relative links are resolved against `baseUrl` (the page URL, unless the page has a `<base>`), and in-page
 * anchors against `url`, when provided.
 */
export const htmlToMarkdown = (html: string | null, url?: string, baseUrl = url): string | null => {
    try {
        if (!html?.length) return null;

        const processor = new TurndownService(turndownSettings);
        if (html.length <= GFM_MAX_HTML_LENGTH) {
            processor.use(plugin.gfm); // Use GitHub Flavored Markdown
        }
        processor.addRule('inlineLink', inlineLinkRule(url ?? '', baseUrl ?? ''));

        return processor.turndown(html);
    } catch (err: unknown) {
        if (err instanceof Error) {
            log.exception(err, `Error while extracting markdown from HTML: ${err.message}`);
        } else {
            log.exception(new Error('Unknown error'), 'Error while extracting markdown from HTML');
        }
        return null;
    }
};
