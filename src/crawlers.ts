import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { ImpitHttpClient } from '@crawlee/impit-client';
import { MemoryStorage } from '@crawlee/memory-storage';
import { PlaywrightBlocker } from '@ghostery/adblocker-playwright';
import { Actor, RequestQueue } from 'apify';
import {
    type CheerioAPI,
    CheerioCrawler,
    type CheerioCrawlerOptions,
    type CheerioCrawlingContext,
    log,
    PlaywrightCrawler,
    type PlaywrightCrawlerOptions,
    type PlaywrightCrawlingContext,
    type RequestOptions,
} from 'crawlee';

import type { CrawlerKind } from './const.js';
import { ContentCrawlerTypes, GOOGLE_STANDARD_RESULTS_PER_PAGE } from './const.js';
import { deduplicateResults, scrapeOrganicResults } from './google-search/google-extractors-urls.js';
import { getMiniActor } from './mini-actors.js';
import { failedRequestHandler, requestHandlerCheerio, requestHandlerPlaywright } from './request-handler.js';
import { addEmptyResultToResponse, sendResponseError } from './responses.js';
import type {
    ContentCrawlerOptions,
    ContentCrawlerUserData,
    ProxyOptions,
    SearchCrawlerOptions,
    SearchCrawlerUserData,
} from './types.js';
import { addTimeMeasureEvent, createRequest, createSearchRequest, isActorStandby, randomId } from './utils.js';

type ContentCrawler = CheerioCrawler | PlaywrightCrawler;

// Pending rather than built, so concurrent requests for one key don't each build a crawler and
// orphan all but the last.
const crawlers = new Map<string, Promise<ContentCrawler>>();
const client = new MemoryStorage({ persistStorage: false });

const contentCrawlerHttpClient = new ImpitHttpClient({
    browser: 'firefox144',
    vanillaFallback: true,
    ignoreTlsErrors: true,
});

let ghosteryBlocker: PlaywrightBlocker | undefined;

async function getGhosteryBlocker(): Promise<PlaywrightBlocker | undefined> {
    if (ghosteryBlocker) {
        return ghosteryBlocker;
    }

    try {
        ghosteryBlocker = PlaywrightBlocker.deserialize(await readFile('./blockers/fanboy-cookiemonster.bin'));
        log.info('Ghostery blocker loaded successfully');
        return ghosteryBlocker;
    } catch (err) {
        log.warning(`Failed to load Ghostery blocker: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}

/** Mirrors how `Actor.createProxyConfiguration` reads these options, so equivalent spellings share a crawler. */
function resolveProxyOptions(proxyOptions: ProxyOptions) {
    const {
        useApifyProxy,
        checkAccess,
        newUrlFunction,
        apifyProxyGroups,
        apifyProxyCountry,
        apifyProxySubdivision,
        ...rest
    } = proxyOptions;

    if (useApifyProxy === false && !rest.proxyUrls) {
        return null;
    }

    return {
        ...rest,
        groups: rest.groups?.length ? rest.groups : apifyProxyGroups,
        countryCode: rest.countryCode || apifyProxyCountry,
        subdivisionCode: rest.subdivisionCode || apifyProxySubdivision,
    };
}

/** `JSON.stringify` with object keys sorted at every level. Array order is kept, it carries meaning. */
function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    const entries = Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
}

/**
 * The proxy options stand in for the constructed `ProxyConfiguration`, whose child logger snapshots
 * the log level and so kept changing the key. Hashed because the key is logged and used as a queue
 * name, while the options can hold credentials.
 */
export function getCrawlerCount() {
    return crawlers.size;
}

export function getCrawlerKey(kind: CrawlerKind, proxyOptions: ProxyOptions): string {
    const hash = createHash('sha1').update(canonicalJson(resolveProxyOptions(proxyOptions))).digest('hex');
    return `${kind}-${hash.slice(0, 12)}`;
}

/** A crawler that fails to build or to run is dropped, so the cache can never hand out a dead one. */
async function getOrCreateCrawler(
    key: string,
    kind: CrawlerKind,
    startCrawler: boolean,
    build: () => Promise<ContentCrawler>,
): Promise<ContentCrawler> {
    const cached = crawlers.get(key);
    if (cached) {
        return cached;
    }

    const pending = (async () => {
        log.info(`Creating new ${kind} crawler with key ${key}`);
        const crawler = await build();
        if (startCrawler) {
            crawler.run().then(
                () => log.warning(`Crawler ${kind} has finished`),
                (err) => {
                    log.error(`Crawler ${kind} failed to run: ${err instanceof Error ? err.message : String(err)}`);
                    crawlers.delete(key);
                },
            );
            log.info(`Crawler ${kind} has started 💪🏼`);
        }
        return crawler;
    })();

    crawlers.set(key, pending);
    pending.catch(() => crawlers.delete(key));
    log.info(`Number of crawlers ${crawlers.size}`);
    return pending;
}

/**
 * Adds a content crawl request to selected content crawler.
 * Get existing crawler based on crawlerOptions and scraperSettings, if not present -> create new
 */
export const addContentCrawlRequest = async (
    request: RequestOptions<ContentCrawlerUserData>,
    responseId: string,
    contentCrawlerKey: string,
) => {
    const pending = crawlers.get(contentCrawlerKey);
    if (!pending) {
        log.error(`Content crawler not found: key ${contentCrawlerKey}`);
        return;
    }

    const crawler = await pending;
    const name = crawler instanceof PlaywrightCrawler ? 'playwright' : 'cheerio';
    try {
        await crawler.requestQueue!.addRequest(request);
        // create an empty result in search request response
        // do not use request.uniqueKey as responseId as it is not id of a search request
        addEmptyResultToResponse(responseId, request);
        log.info(`Added request to the ${name}-content-crawler: ${request.url}`);
    } catch (err) {
        log.error(`Error adding request to ${name}-content-crawler: ${request.url}, error: ${err}`);
    }
};

/**
 * Creates and starts a Google search crawler with the provided configuration.
 * A crawler won't be created if it already exists.
 */
export async function createAndStartSearchCrawler(
    searchCrawlerOptions: SearchCrawlerOptions,
    startCrawler = true,
) {
    const { crawlerOptions, proxyOptions } = searchCrawlerOptions;
    const key = getCrawlerKey('search', proxyOptions);
    const crawler = await getOrCreateCrawler(key, 'search', startCrawler, async () => new CheerioCrawler({
        ...crawlerOptions,
        requestQueue: await RequestQueue.open(key, { storageClient: client }),
        requestHandler: async ({ request, $: _$, addRequests }: CheerioCrawlingContext<SearchCrawlerUserData>) => {
            // NOTE: we need to cast this to fix `cheerio` type errors
            addTimeMeasureEvent(request.userData!, 'cheerio-request-handler-start');
            const $ = _$ as CheerioAPI;

            log.info(`Search-crawler requestHandler: Processing URL: ${request.url}`);
            const organicResults = scrapeOrganicResults($);

            // Destructure userData for easier access (pagination fields are initialized in createSearchRequest)
            const { collectedResults, currentPage, totalPages, maxResults, userAuthorization } = request.userData;

            // Merge with previously collected results and deduplicate
            const allResults = [...collectedResults, ...organicResults];
            const deduplicated = deduplicateResults(allResults);

            log.info(`Page ${currentPage + 1}/${totalPages}: Extracted ${organicResults.length} results, Total unique: ${deduplicated.length}/${maxResults}`);

            // Decide whether to fetch the next page
            // Continue fetching if: (1) we haven't reached maxResults AND (2) we haven't exceeded totalPages AND (3) Google returned results
            const shouldFetchNextPage = deduplicated.length < maxResults
                && currentPage + 1 < totalPages
                && organicResults.length > 0; // Stop if Google returned 0 results (empty page)

            if (shouldFetchNextPage) {
                // Queue the next page
                const nextPage = currentPage + 1;
                const nextOffset = nextPage * GOOGLE_STANDARD_RESULTS_PER_PAGE;
                // We convert index to human readable number for logging (1-indexed)
                const nextPageHumanReadableNumber = nextPage + 1;
                log.info(`Enqueueing next page (${nextPageHumanReadableNumber}/${totalPages}) with offset ${nextOffset}`);

                const nextRequest = createSearchRequest(
                    {
                        ...request.userData,
                        collectedResults: deduplicated,
                        currentPage: nextPage,
                    },
                    proxyOptions,
                    nextOffset,
                );
                await addRequests([nextRequest]);
            } else {
                // We have enough results or reached max pages, proceed to content crawling
                const finalResults = deduplicated.slice(0, request.userData.maxResults);
                log.info(`Pagination complete. Extracted ${finalResults.length} results.`, { finalResults: finalResults.map((r) => r.url) });

                addTimeMeasureEvent(request.userData!, 'before-playwright-queue-add');
                const responseId = request.userData.responseId!;
                let rank = 1;
                for (const result of finalResults) {
                    result.rank = rank++;
                    const r = createRequest(
                        request.userData.query,
                        result,
                        responseId,
                        request.userData.contentScraperSettings!,
                        request.userData.timeMeasures!,
                        userAuthorization,
                    );
                    await addContentCrawlRequest(r, responseId, request.userData.contentCrawlerKey!);
                }
            }
        },
        failedRequestHandler: async ({ request }, err) => {
            addTimeMeasureEvent(request.userData!, 'cheerio-failed-request');
            log.error(`Google-search-crawler failed to process request ${request.url}, error ${err.message}`);
            const errorResponse = { errorMessage: err.message };
            sendResponseError(request.uniqueKey, JSON.stringify(errorResponse));
        },
    }));

    return { key, crawler };
}

/**
 * Creates and starts a content crawler with the provided configuration.
 * Either Playwright or Cheerio crawler will be created based on the provided crawler options.
 * A crawler won't be created if it already exists.
 */
export async function createAndStartContentCrawler(
    contentCrawlerOptions: ContentCrawlerOptions,
    startCrawler = true,
) {
    const { type: crawlerType, crawlerOptions, proxyOptions } = contentCrawlerOptions;

    const key = getCrawlerKey(crawlerType, proxyOptions);
    const crawler = await getOrCreateCrawler(key, crawlerType, startCrawler, async () => (
        crawlerType === ContentCrawlerTypes.PLAYWRIGHT
            ? createPlaywrightContentCrawler(crawlerOptions, key)
            : createCheerioContentCrawler(crawlerOptions, key)
    ));

    return { key, crawler };
}

const URL_TO_MARKDOWN_PPE_EVENTS = {
    RAW_HTTP: 'raw-http-result',
    PLAYWRIGHT: 'playwright-result',
};

async function createPlaywrightContentCrawler(
    crawlerOptions: PlaywrightCrawlerOptions,
    key: string,
): Promise<PlaywrightCrawler> {
    const blocker = await getGhosteryBlocker();
    return new PlaywrightCrawler({
        ...crawlerOptions,
        keepAlive: crawlerOptions.keepAlive,
        requestQueue: await RequestQueue.open(key, { storageClient: client }),
        requestHandler: (async (context) => {
            const typedContext = context as unknown as PlaywrightCrawlingContext<ContentCrawlerUserData>;
            await requestHandlerPlaywright(typedContext, blocker);
            await maybeCharge(ContentCrawlerTypes.PLAYWRIGHT, typedContext.request.userData.userAuthorization);
        }),
        failedRequestHandler: async ({ request }, err) => {
            await failedRequestHandler(request, err, ContentCrawlerTypes.PLAYWRIGHT);
        },
    });
}

async function createCheerioContentCrawler(
    crawlerOptions: CheerioCrawlerOptions,
    key: string,
): Promise<CheerioCrawler> {
    return new CheerioCrawler({
        ...crawlerOptions,
        keepAlive: crawlerOptions.keepAlive,
        httpClient: contentCrawlerHttpClient,
        requestQueue: await RequestQueue.open(key, { storageClient: client }),
        requestHandler: (async (context) => {
            const typedContext = context as unknown as CheerioCrawlingContext<ContentCrawlerUserData>;
            await requestHandlerCheerio(typedContext);
            await maybeCharge(ContentCrawlerTypes.CHEERIO, typedContext.request.userData.userAuthorization);
        }),
        failedRequestHandler: async ({ request }, err) => {
            await failedRequestHandler(request, err, ContentCrawlerTypes.CHEERIO);
        },
    });
}

function getEventName(crawlerType: ContentCrawlerTypes): string {
    return crawlerType === ContentCrawlerTypes.PLAYWRIGHT
        ? URL_TO_MARKDOWN_PPE_EVENTS.PLAYWRIGHT
        : URL_TO_MARKDOWN_PPE_EVENTS.RAW_HTTP;
}

/**
 * Normal (non-standby) single-run charging via the Actor SDK.
 */
async function chargeNormal(eventName: string): Promise<void> {
    await Actor.charge({ eventName });
}

/**
 * Multi-tenant standby charging: POSTs directly to the platform charge REST endpoint,
 * passing the calling end-user's authorization so that user (not the Actor owner) is billed.
 */
async function chargeStandby(eventName: string, userAuthorization: string): Promise<void> {
    const { apiBaseUrl, actorRunId, token } = Actor.getEnv();
    if (!apiBaseUrl || !actorRunId || !token) {
        log.warning(`Skipping standby charge for ${eventName} event: missing apiBaseUrl/actorRunId/token from Actor.getEnv().`);
        return;
    }
    const url = `${apiBaseUrl}v2/actor-runs/${actorRunId}/charge`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': randomId(),
        },
        body: JSON.stringify({ eventName, count: 1, userAuthorization }),
    });
    if (!response.ok) {
        const resText = await response.text();
        throw new Error(`Charging failed: ${resText}`);
    }
}

/**
 * Dispatches to the correct charging path (normal single-run vs. multi-tenant standby)
 * based on isActorStandby().
 */
async function maybeCharge(crawlerType: ContentCrawlerTypes, userAuthorization?: string) {
    if (getMiniActor().name !== 'url-to-markdown') {
        return;
    }
    const eventName = getEventName(crawlerType);
    try {
        if (isActorStandby()) {
            if (!userAuthorization) {
                log.warning(`Skipping standby charge for ${eventName} event: missing userAuthorization (x-apify-user-authorization header was not provided).`);
                return;
            }
            await chargeStandby(eventName, userAuthorization);
        } else {
            await chargeNormal(eventName);
        }
    } catch (err) {
        log.error(`Failed to charge for ${eventName} event: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * Adds a search request to the Google search crawler identified by `searchCrawlerKey`.
 * Create a response for the request and set the desired number of results (maxResults).
 */
export const addSearchRequest = async (
    request: RequestOptions<ContentCrawlerUserData>,
    searchCrawlerKey: string,
) => {
    const pending = crawlers.get(searchCrawlerKey);
    if (!pending) {
        log.error(`Search crawler not found: key ${searchCrawlerKey}`);
        return;
    }

    const crawler = await pending;
    addTimeMeasureEvent(request.userData!, 'before-cheerio-queue-add');
    await crawler.requestQueue!.addRequest(request);
    log.info(`Added request to cheerio-google-search-crawler: ${request.url}`);
};
