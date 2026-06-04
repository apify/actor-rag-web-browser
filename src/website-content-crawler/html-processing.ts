import type { CheerioAPI } from 'crawlee';
import { log } from 'crawlee';

import type { ContentScraperSettings } from '../types.js';
import { readableText } from './text-extractor.js';

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

    const simplified = typeof simplifiedBody === 'string'
        ? `<html lang="">
        <head>
            <title>
                ${$('title').text()}
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
            ret = await readableText({ html: simplified, url, options: { fallbackToNone: false } });
        } catch (error) {
            log.warning(`Processing of HTML failed with error:`, { error });
        }
    }
    return ret ?? (simplified as string);
}
