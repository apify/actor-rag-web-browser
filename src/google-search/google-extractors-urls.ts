import { Actor } from 'apify';
import { type CheerioAPI, gotScraping, log, type ProxyConfiguration } from 'crawlee';
import type { Element } from 'domhandler';

import type { OrganicResult, SearchResultType } from '../types.js';

// Google's click-tracking redirect endpoints, sometimes served instead of a plain result anchor.
// Relative to the page origin; resolved to the real destination by resolveGoogleRedirectUrls.
const GOOGLE_REDIRECT_PATHNAMES = new Set(['/goto', '/url']);

// Searches always run on www.google.com (see createSearchRequest), so redirect links point there too
const GOOGLE_HOSTNAME = 'www.google.com';
const GOOGLE_ORIGIN = `https://${GOOGLE_HOSTNAME}`;

const MAX_RESOLVE_ATTEMPTS = 3;

function isGoogleRedirectPath(href: string): boolean {
    return GOOGLE_REDIRECT_PATHNAMES.has(href.split(/[?#]/)[0]);
}

/** Google pages a redirect can lead to that are not results: consent, captcha or another redirect hop. */
function isGoogleInterstitial(url: URL): boolean {
    if (url.hostname === 'consent.google.com') {
        return true;
    }
    return url.hostname === GOOGLE_HOSTNAME && (url.pathname.startsWith('/sorry') || GOOGLE_REDIRECT_PATHNAMES.has(url.pathname));
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
 * Deduplicates search results by URL; a page listed under different titles is still one page.
 */
export const deduplicateResults = <T extends { url?: string }>(results: T[]): T[] => {
    const uniqueResults: T[] = [];
    const seenUrls = new Set<string | undefined>();
    for (const result of results) {
        if (seenUrls.has(result.url)) continue;
        seenUrls.add(result.url);
        uniqueResults.push(result);
    }
    return uniqueResults;
};

/**
 * Parses a single organic search result (source: @apify/google-search).
 */
const parseResult = ($: CheerioAPI, el: Element) => {
    $(el).find('div.action-menu').remove();

    const descriptionSelector = '.VwiC3b';
    const href = $(el).find('a').first().attr('href') || '';
    const searchResult: OrganicResult = {
        title: $(el).find('h3').first().text() || '',
        description: ($(el).find(descriptionSelector).text() || '').trim(),
        url: href && isGoogleRedirectPath(href) ? new URL(href, GOOGLE_ORIGIN).href : href,
    };

    return searchResult;
};

/**
 * Extracts search results from the given selectors (source: @apify/google-search).
 */
const extractResultsFromSelectors = ($: CheerioAPI, selectors: string[]) => {
    const searchResults: OrganicResult[] = [];
    const selector = selectors.join(', ');
    for (const resultEl of $(selector)) {
        const results = $(resultEl).map((_i, el) => parseResult($, el as Element)).toArray();
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
export const scrapeOrganicResults = ($: CheerioAPI): OrganicResult[] => {
    const resultSelectors2023January = [
        '.hlcw0c', // Top result with site links
        '.g.Ww4FFb', // General search results
        '.MjjYud', // General search results 2025 March, this includes also images so we need to add a check that results has both title and url
        '.g .tF2Cxc>.yuRUbf', // old search selector 2021 January
        '.g [data-header-feature="0"]', // old search selector 2022 January
        '.g .rc', // very old selector
        '.sATSHe', // another new selector in March 2025
    ];

    const searchResults = extractResultsFromSelectors($, resultSelectors2023January);
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

const parseGoogleRedirectUrl = (url: string): URL | null => {
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(url);
    } catch {
        return null;
    }
    const isHttp = parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    if (!isHttp || parsedUrl.hostname !== GOOGLE_HOSTNAME || !GOOGLE_REDIRECT_PATHNAMES.has(parsedUrl.pathname)) {
        return null;
    }
    return parsedUrl;
};

/** /url links carry their destination in the q (or url) parameter, so it can be read without asking Google. */
const readUrlDestination = (parsedUrl: URL): string | null => {
    const param = parsedUrl.searchParams.get('q') ?? parsedUrl.searchParams.get('url');
    if (parsedUrl.pathname !== '/url' || !param) {
        return null;
    }
    let destination: URL;
    try {
        destination = new URL(param);
    } catch {
        return null;
    }
    return isValidUrl(destination.href) && !isGoogleInterstitial(destination) ? destination.href : null;
};

const resolveGoogleRedirectUrl = async (parsedUrl: URL, proxyConfig: ProxyConfiguration | undefined): Promise<string> => {
    const response = await gotScraping({
        url: parsedUrl.toString(),
        followRedirect: false,
        proxyUrl: await proxyConfig?.newUrl(),
        timeout: { request: 5_000 },
    });
    const statusCode = response?.statusCode;
    const location: unknown = response?.headers?.location;
    if (statusCode < 300 || statusCode >= 400 || typeof location !== 'string') {
        throw new Error(`response is not a redirect (status ${statusCode})`);
    }
    // Google's own pages (captcha, consent) also come as redirects; failing here keeps them from winning the race
    const destination = new URL(location, parsedUrl);
    if (!isValidUrl(destination.href) || isGoogleInterstitial(destination)) {
        throw new Error(`redirect does not lead to a result page: ${destination.href}`);
    }
    return destination.href;
};

/**
 * Replaces Google's redirect urls (/goto and /url) with their destination.
 * /url links are read locally; /goto links (and /url without a usable destination) from Google's redirect response.
 */
export const resolveGoogleRedirectUrls = async (results: OrganicResult[]): Promise<OrganicResult[]> => {
    const proxyConfig = await Actor.createProxyConfiguration({ checkAccess: false });

    const resolvedResults = await Promise.all(
        results.map(async (result) => {
            const parsedUrl = result.url && parseGoogleRedirectUrl(result.url);
            if (!parsedUrl) {
                return result;
            }
            const urlDestination = readUrlDestination(parsedUrl);
            if (urlDestination) {
                return { ...result, url: urlDestination };
            }

            // Attempts run in parallel, each through a different proxy IP, and the first to resolve wins
            try {
                const attempts = Array.from({ length: MAX_RESOLVE_ATTEMPTS }, async () => resolveGoogleRedirectUrl(parsedUrl, proxyConfig));
                return { ...result, url: await Promise.any(attempts) };
            } catch (error) {
                const errors = (error as AggregateError).errors.map((attemptError) => `${attemptError}`);
                log.warning('Failed to resolve Google redirect url', { errors, url: result.url });
                return null;
            }
        }),
    );
    return resolvedResults.filter((result) => result !== null);
};
