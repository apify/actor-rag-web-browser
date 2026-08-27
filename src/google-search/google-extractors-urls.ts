import type { CheerioAPI } from 'crawlee';
import type { Element } from 'domhandler';

import type { OrganicResult, SearchResultType } from '../types.js';

// Google's click-tracking redirect endpoints, sometimes served instead of a plain result anchor.
// Relative to the page origin; crawling them lets Google's redirect resolve to the real destination.
const GOOGLE_REDIRECT_PATH_PREFIXES = ['/goto', '/url'];

function isGoogleRedirectPath(href: string): boolean {
    return GOOGLE_REDIRECT_PATH_PREFIXES.some((prefix) => href === prefix || href.startsWith(`${prefix}?`) || href.startsWith(`${prefix}/`));
}

/** Resolves a Google redirect href against the page it was loaded from. */
function resolveUrl(href: string, pageUrl: string): string {
    try {
        return new URL(href, pageUrl).href;
    } catch {
        return href;
    }
}

/** Validates that a URL is absolute http/https and not one of Google's own internal search links. */
function isValidUrl(url: string): boolean {
    if (!url || typeof url !== 'string') {
        return false;
    }

    try {
        const urlObj = new URL(url);
        if ((urlObj.hostname === 'google.com' || urlObj.hostname.endsWith('.google.com')) && urlObj.pathname.startsWith('/search')) {
            return false;
        }
        return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Deduplicates search results based on their title and URL (source @apify/google-search).
 */
export const deduplicateResults = <T extends { title?: string; url?: string }>(results: T[]): T[] => {
    const deduplicatedResults = [];
    const resultHashes = new Set();
    for (const result of results) {
        // date defaults to now so it is not stable
        const hash = JSON.stringify({ title: result.title, url: result.url });
        if (!resultHashes.has(hash)) {
            deduplicatedResults.push(result);
            resultHashes.add(hash);
        }
    }
    return deduplicatedResults;
};

/**
 * Parses a single organic search result (source: @apify/google-search).
 */
const parseResult = ($: CheerioAPI, el: Element, pageUrl: string) => {
    $(el).find('div.action-menu').remove();

    const descriptionSelector = '.VwiC3b';
    const href = $(el).find('a').first().attr('href') || '';
    const searchResult: OrganicResult = {
        title: $(el).find('h3').first().text() || '',
        description: ($(el).find(descriptionSelector).text() || '').trim(),
        url: href && isGoogleRedirectPath(href) ? resolveUrl(href, pageUrl) : href,
    };

    return searchResult;
};

/**
 * Extracts search results from the given selectors (source: @apify/google-search).
 */
const extractResultsFromSelectors = ($: CheerioAPI, selectors: string[], pageUrl: string) => {
    const searchResults: OrganicResult[] = [];
    const selector = selectors.join(', ');
    for (const resultEl of $(selector)) {
        const results = $(resultEl).map((_i, el) => parseResult($, el as Element, pageUrl)).toArray();
        for (const result of results) {
            // Only include results with both title and a valid URL
            // URL validation filters out Google's internal search links and malformed URLs
            // that would cause errors during content crawling
            if (result.title && result.url && isValidUrl(result.url)) {
                searchResults.push(result);
            }
        }
    }
    return searchResults;
};

/**
 * If true, the results are not inherent to the given query, but to a similar suggested query
 */
const areTheResultsSuggestions = ($: CheerioAPI) => {
    // Check if the message "No results found" is shown
    return $('div#topstuff > div.fSp71d').children().length > 0;
};

/**
 * Extracts organic search results from the given Cheerio instance (source: @apify/google-search).
 */
export const scrapeOrganicResults = ($: CheerioAPI, pageUrl: string): OrganicResult[] => {
    const resultSelectors2023January = [
        '.hlcw0c', // Top result with site links
        '.g.Ww4FFb', // General search results
        '.MjjYud', // General search results 2025 March, this includes also images so we need to add a check that results has both title and url
        '.g .tF2Cxc>.yuRUbf', // old search selector 2021 January
        '.g [data-header-feature="0"]', // old search selector 2022 January
        '.g .rc', // very old selector
        '.sATSHe', // another new selector in March 2025
    ];

    const searchResults = extractResultsFromSelectors($, resultSelectors2023January, pageUrl);
    const deduplicatedResults = deduplicateResults(searchResults);
    let resultType: SearchResultType = 'ORGANIC';
    if (areTheResultsSuggestions($)) {
        resultType = 'SUGGESTED';
    }
    return deduplicatedResults.map((result) => ({
        ...result,
        resultType,
    }));
};
