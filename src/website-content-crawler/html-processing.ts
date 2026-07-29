import type { CheerioAPI } from 'crawlee';
import { log } from 'crawlee';

import type { ContentScraperSettings } from '../types.js';
import { readableText } from './text-extractor.js';

const SKIP_CHILD_OF_ELEMENT_SELECTORS = ['.crawlee-iframe-replacement *', 'svg *'].join(', ');
const TITLE_SELECTORS = [
    `head > title:not(${SKIP_CHILD_OF_ELEMENT_SELECTORS})`,
    `title:not(${SKIP_CHILD_OF_ELEMENT_SELECTORS})`,
];

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
