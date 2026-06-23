import { parse } from 'node:querystring';

import { Actor } from 'apify';
import type { ProxyConfiguration, RequestOptions } from 'crawlee';
import { log } from 'crawlee';

import ragWebBrowserInputSchema from '../actors/apify_rag-web-browser/.actor/input_schema.json' with { type: 'json' };
import urlToMarkdownInputSchema from '../actors/apify_url-to-markdown/.actor/input_schema.json' with { type: 'json' };
import type {
    ContentCrawlerUserData,
    ContentScraperSettings,
    CreateSearchRequestUserData,
    Input,
    OrganicResult, OutputFormats,
    SearchCrawlerUserData,
    TimeMeasure,
} from './types.js';

const inputSchema = {
    properties: {
        ...ragWebBrowserInputSchema.properties,
        ...urlToMarkdownInputSchema.properties,
    },
};

const SCHEMELESS_URL_DOMAIN_SUFFIXES = [
    'com',
    'net',
    'org',
    'ai',
    'io',
    'co',
    'co.uk',
    'edu',
    'gov',
    'biz',
    'info',
    'us',
    'shop',
];

const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function isActorStandby(): boolean {
    return Actor.getEnv().metaOrigin === 'STANDBY';
}

/**
 * Parse the query parameters from the URL
 */
export function parseParameters(url: string): Partial<Input> {
    const params = parse(url.slice(1));

    type SchemaKey = keyof Input;

    const parsedInput: Partial<Input> = {};
    for (const [key, value] of Object.entries(params)) {
        // If the value is undefined skip it
        if (value === undefined) continue;

        // If the key is not supported by schema or is not Apify API token, skip it
        if (key !== 'token' && !Object.keys(inputSchema.properties).includes(key)) {
            log.warning(`Unknown parameter: ${key}. Supported parameters: ${Object.keys(inputSchema.properties).join(', ')}`);
            continue;
        }

        const typedKey = key as SchemaKey;

        // Parse outputFormats parameter as an array of OutputFormats
        if (typedKey === 'outputFormats' && typeof value === 'string') {
            parsedInput[typedKey] = value.split(',').map((format) => format.trim()) as OutputFormats[];
        }

        // Parse non-primitive parameters following input schema because querystring doesn't parse objects
        if (
            !!inputSchema.properties[typedKey]
            && ['object', 'array'].includes(inputSchema.properties[typedKey].type)
            && typeof value === 'string'
        ) {
            try {
                parsedInput[typedKey] = JSON.parse(value);
                log.debug(`Parsed parameter ${key} from string: ${value} to object`, parsedInput[typedKey] as object);
            } catch (e) {
                log.warning(`Failed to parse parameter ${key}, it must be valid JSON. Skipping it: ${e}`);
            }
        } else {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-expect-error
            parsedInput[typedKey] = value;
        }
    }

    return parsedInput;
}

export function randomId() {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let counter = 0; counter < 10; counter++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

/**
 * Create a search request with the provided query and maxResults.
 * The maxResults parameter is passed to the UserData object, when the request is handled it is used to limit
 * the number of search results retrieved through pagination.
 *
 * Also add the contentCrawlerKey to the UserData object to be able to identify which content crawler should
 * handle the crawling.
 *
 * Supports pagination via startOffset parameter for fetching additional pages.
 * Note: Google ignores the ?num parameter and returns at most 10 results per page.
 * We use the ?start parameter for pagination to retrieve results across multiple pages.
 * We add +1 to the calculated totalPages to account for pages that return fewer than 10 results.
 */
export function createSearchRequest(
    userData: CreateSearchRequestUserData,
    proxyConfiguration: ProxyConfiguration | undefined,
    startOffset = 0,
): RequestOptions<SearchCrawlerUserData> {
    // Initialize or update pagination fields
    const collectedResults = userData.collectedResults || [];
    const currentPage = userData.currentPage ?? 0;
    const totalPages = userData.totalPages ?? Math.ceil(userData.maxResults / 10) + 1;

    // @ts-expect-error is there a better way to get group information?
    // (e.g. to  create extended CheerioCrawlOptions and pass it there?)
    const groups = proxyConfiguration?.groups || [];
    const protocol = groups.includes('GOOGLE_SERP') ? 'http' : 'https';
    const urlSearch = startOffset > 0
        ? `${protocol}://www.google.com/search?q=${encodeURI(userData.query)}&start=${startOffset}`
        : `${protocol}://www.google.com/search?q=${encodeURI(userData.query)}`;
    return {
        url: urlSearch,
        uniqueKey: randomId(),
        userData: {
            maxResults: userData.maxResults,
            timeMeasures: userData.timeMeasures || [],
            query: userData.query,
            contentCrawlerKey: userData.contentCrawlerKey,
            contentScraperSettings: userData.contentScraperSettings,
            responseId: userData.responseId,
            collectedResults,
            currentPage,
            totalPages,
        },
    };
}

/**
 * Create a request for content crawler with the provided query, result, responseId and timeMeasures.
 */
export function createRequest(
    query: string,
    result: OrganicResult,
    responseId: string,
    contentScraperSettings: ContentScraperSettings,
    timeMeasures: TimeMeasure[] | null = null,
): RequestOptions<ContentCrawlerUserData> {
    return {
        url: result.url!,
        uniqueKey: randomId(),
        userData: {
            query,
            responseId,
            searchResult: result.url && result.title ? result : undefined,
            timeMeasures: timeMeasures ? [...timeMeasures] : [],
            contentScraperSettings,
        },
    };
}

export function addTimeMeasureEvent(userData: ContentCrawlerUserData, event: TimeMeasure['event'], time: number | null = null) {
    /* eslint-disable no-param-reassign */
    let timePrev = 0;
    if (!userData.timeMeasures?.length) {
        userData.timeMeasures = [];
    } else {
        timePrev = userData.timeMeasures[userData.timeMeasures.length - 1].timeMs;
    }
    time = time ?? Date.now();
    userData.timeMeasures.push({ event, timeMs: time, timeDeltaPrevMs: timePrev ? time - timePrev : 0 });
    /* eslint-enable no-param-reassign */
}

export function transformTimeMeasuresToRelative(timeMeasures: TimeMeasure[]): TimeMeasure[] {
    const firstMeasure = timeMeasures[0].timeMs;
    return timeMeasures
        .map((measure) => {
            return {
                event: measure.event,
                timeMs: measure.timeMs - firstMeasure,
                timeDeltaPrevMs: measure.timeDeltaPrevMs,
            };
        })
        .sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Interpret the input as an HTTP(S) URL.
 * URLs without a protocol are accepted only for a limited set of well-known domain suffixes.
 * This prevents search queries such as "famous.actor" from being interpreted as URLs.
 * If the input is not initially valid, try to decode it and check again.
 * Attempt to decode the input string up to 3 times, as users may encode the URL multiple times.
 * @param input - The input string to interpret as a URL.
 * @returns The valid URL string or null if invalid.
 */
export function interpretAsUrl(input: string): string | null {
    if (!input) return null;

    function hasSupportedDomainSuffix(hostname: string): boolean {
        const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');
        const labels = normalizedHostname.split('.');

        if (!labels.every((label) => DOMAIN_LABEL_PATTERN.test(label))) return false;

        return SCHEMELESS_URL_DOMAIN_SUFFIXES.some((suffix) => normalizedHostname.endsWith(`.${suffix}`));
    }

    function tryValid(s: string): string | null {
        const trimmed = s.trim();
        if (/\s/.test(trimmed)) return null;

        try {
            const url = new URL(trimmed);
            if (/^https?:/i.test(url.protocol)) return url.href;
        } catch {
            // Continue by checking whether this is a supported URL without a protocol.
        }

        try {
            const url = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : `https://${trimmed}`);
            if (url.username || url.password) return null;

            return hasSupportedDomainSuffix(url.hostname) ? url.href : null;
        } catch {
            return null;
        }
    }

    let candidate = input;
    for (let i = 0; i < 3; i++) {
        const result = tryValid(candidate);
        if (result) return result;
        try {
            candidate = decodeURIComponent(candidate);
        } catch {
            break;
        }
    }
    return null;
}
