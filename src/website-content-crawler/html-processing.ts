import type { CheerioAPI } from 'crawlee';
import { log } from 'crawlee';

import type { ContentScraperSettings, OpenGraphProperty } from '../types.js';
import { readableText } from './text-extractor.js';

const SKIP_CHILD_OF_ELEMENT_SELECTORS = ['.crawlee-iframe-replacement *', 'svg *'].join(', ');
const TITLE_SELECTORS = [
    `head > title:not(${SKIP_CHILD_OF_ELEMENT_SELECTORS})`,
    `title:not(${SKIP_CHILD_OF_ELEMENT_SELECTORS})`,
];

const OPEN_GRAPH_PREFIXES = ['og:', 'article:', 'book:', 'profile:', 'video:', 'website:', 'twitter:'];
const OPEN_GRAPH_SELECTOR = OPEN_GRAPH_PREFIXES.map((prefix) => `meta[property^="${prefix}"]`).join(', ');

/**
 * Extracts the page title (source: Website Content Crawler).
 *
 * Prefers the `<title>` in `<head>` and ignores `<title>` elements nested in SVGs
 * (used there as tooltips) or in Crawlee iframe replacement nodes.
 */
export function extractTitle($: CheerioAPI): string {
    for (const selector of TITLE_SELECTORS) {
        const title = $(selector).first().text().trim();
        if (title) {
            return title;
        }
    }
    return '';
}

export function extractCanonicalUrl($: CheerioAPI, baseUrl: string): string | undefined {
    const href = $('html > head > link[rel="canonical"]').first().attr('href');
    if (!href) return undefined;

    try {
        const url = new URL(href, baseUrl);
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {
        // Handled by the log below.
    }

    log.debug(`Ignoring the canonical link of ${baseUrl}, which is not an HTTP(S) URL: ${href}`);
    return undefined;
}

export function extractOpenGraphProperties($: CheerioAPI): OpenGraphProperty[] | undefined {
    const properties = $(OPEN_GRAPH_SELECTOR).get().flatMap((element) => {
        const property = $(element).attr('property');
        const content = $(element).attr('content');
        return property && content ? [{ property, content }] : [];
    });

    return properties.length > 0 ? properties : undefined;
}

/**
 * Extracts the JSON-LD structured data of the page (source: Website Content Crawler).
 */
export function extractJsonLd($: CheerioAPI): unknown[] | undefined {
    const items = $('script[type="application/ld+json"]').get().flatMap((element) => {
        try {
            return [JSON.parse($(element).text())];
        } catch {
            log.debug('Skipping a JSON-LD script that does not contain valid JSON.');
            return [];
        }
    });

    return items.length > 0 ? items : undefined;
}

/**
 * Process HTML with the selected HTML transformer (source: Website Content Crawler).
 */
export async function processHtml(
    html: string | null,
    url: string,
    settings: ContentScraperSettings,
    $: CheerioAPI,
): Promise<string> {
    const $body = $('body').clone();
    if (settings.removeElementsCssSelector) {
        $body.find(settings.removeElementsCssSelector).remove();
    }
    const simplifiedBody = $body.html()?.trim();
    const title = extractTitle($);

    const simplified = typeof simplifiedBody === 'string'
        ? `<html lang="">
        <head>
            <title>
                ${title}
            </title>
        </head>
        <body>
            ${simplifiedBody}
        </body>
    </html>`
        : (html ?? '');

    let ret = null;
    if (settings.htmlTransformer === 'readableText') {
        try {
            ret = await readableText({ html: simplified, url, options: { fallbackToNone: true } });
        } catch (error) {
            log.warning(`Processing of HTML failed with error:`, { error });
        }
    }
    return ret ?? (simplified as string);
}
