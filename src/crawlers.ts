import { readFile } from 'node:fs/promises';

import { ImpitHttpClient } from '@crawlee/impit-client';
import { MemoryStorage } from '@crawlee/memory-storage';
import { PlaywrightBlocker } from '@ghostery/adblocker-playwright';
import { RequestQueue } from 'apify';
import {
    type CheerioAPI,
    CheerioCrawler,
    type CheerioCrawlerOptions,
    type CheerioCrawlingContext,
    log,
    PlaywrightCrawler,
    type PlaywrightCrawlerOptions,
    type PlaywrightCrawlingContext,
    type Request,
    type RequestOptions,
} from 'crawlee';

import { chargeFetch, chargeSearch } from './charging.js';
import type { CrawlerKind } from './const.js';
import { ContentCrawlerTypes, GOOGLE_STANDARD_RESULTS_PER_PAGE } from './const.js';
import { deduplicateResults, scrapeOrganicResults } from './google-search/google-extractors-urls.js';
import {
    failedRequestHandler,
    requestHandlerCheerio,
    requestHandlerPlaywright,
    TEXT_DOCUMENT_CONTENT_TYPES,
} from './request-handler.js';
import { addEmptyResultToResponse, addResultToResponse, sendResponseError, sendResponseIfFinished } from './responses.js';
import type {
    ContentCrawlerOptions,
    ContentCrawlerUserData,
    Output,
    SearchCrawlerUserData,
} from './types.js';
import { addTimeMeasureEvent, createRequest, createSearchRequest } from './utils.js';

type Crawler = CheerioCrawler | PlaywrightCrawler;

const crawlers = new Map<CrawlerKind, Promise<Crawler>>();
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

export function getCrawlerCount() {
    return crawlers.size;
}

/** Drops a crawler only if it is still the cached one, so a replacement is never evicted. */
function evict(kind: CrawlerKind, crawlerPromise: Promise<Crawler>) {
    if (crawlers.get(kind) === crawlerPromise) crawlers.delete(kind);
}

/**
 * Caches the promise rather than the crawler, so concurrent requests arriving while one is still
 * building share it instead of each building their own.
 */
async function getOrCreateCrawler(kind: CrawlerKind, startCrawler: boolean, build: () => Promise<Crawler>) {
    const cached = crawlers.get(kind);
    if (cached) {
        return cached;
    }

    const crawlerPromise = (async () => {
        log.info(`Creating new ${kind} crawler`);
        const crawler = await build();
        if (startCrawler) {
            crawler.run().then(
                () => log.warning(`Crawler ${kind} has finished`),
                (err) => log.error(`Crawler ${kind} failed to run: ${err instanceof Error ? err.message : String(err)}`),
            ).finally(() => evict(kind, crawlerPromise));
            log.info(`Crawler ${kind} has started 💪🏼`);
        }
        return crawler;
    })();

    crawlers.set(kind, crawlerPromise);
    crawlerPromise.catch(() => evict(kind, crawlerPromise));
    log.info(`Number of crawlers ${crawlers.size}`);
    return crawlerPromise;
}

/**
 * Adds a content crawl request to the content crawler identified by `contentCrawlerKey`.
 */
export const addContentCrawlRequest = async (
    request: RequestOptions<ContentCrawlerUserData>,
    responseId: string,
    contentCrawlerKey: CrawlerKind,
) => {
    const crawlerPromise = crawlers.get(contentCrawlerKey);
    if (!crawlerPromise) {
        log.error(`Content crawler not found: ${contentCrawlerKey}`);
        sendResponseError(responseId, 'The content crawler is restarting. Please retry.');
        return;
    }

    const crawler = await crawlerPromise;
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
    searchCrawlerOptions: CheerioCrawlerOptions,
    startCrawler = true,
) {
    const key: CrawlerKind = 'search';
    const crawler = await getOrCreateCrawler(key, startCrawler, async () => new CheerioCrawler({
        ...searchCrawlerOptions,
        requestQueue: await RequestQueue.open(key, { storageClient: client }),
        requestHandler: async ({ request, $: _$, addRequests }: CheerioCrawlingContext<SearchCrawlerUserData>) => {
            // NOTE: we need to cast this to fix `cheerio` type errors
            addTimeMeasureEvent(request.userData!, 'cheerio-request-handler-start');
            const $ = _$ as CheerioAPI;

            log.info(`Search-crawler requestHandler: Processing URL: ${request.url}`);
            const organicResults = scrapeOrganicResults($, request.loadedUrl ?? request.url);

            // Destructure userData for easier access (pagination fields are initialized in createSearchRequest)
            const { collectedResults, currentPage, totalPages, maxResults, actorRequestId } = request.userData;

            // Charged for a page of results rather than for submitting the query, so a search Google
            // refuses stays free - but before anything is enqueued, or the response could beat the charge
            // and invalidate the caller's request ID. The flag rides along with the request, so a retry
            // of this handler cannot charge the query twice.
            if (organicResults.length > 0 && !request.userData.isSearchChargeAttempted) {
                request.userData.isSearchChargeAttempted = true;
                await chargeSearch({ actorRequestId, idempotencyKey: request.uniqueKey });
            }

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
                        request.userData.contentProxyOptions,
                        request.userData.timeMeasures!,
                        actorRequestId,
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
    const { type: crawlerType, crawlerOptions } = contentCrawlerOptions;

    const crawler = await getOrCreateCrawler(crawlerType, startCrawler, async () => (
        crawlerType === ContentCrawlerTypes.PLAYWRIGHT
            ? createPlaywrightContentCrawler(crawlerOptions, crawlerType)
            : createCheerioContentCrawler(crawlerOptions, crawlerType)
    ));

    return { key: crawlerType, crawler };
}

/**
 * Sends at most one charge per page: Crawlee retries a handler that fails after its charge went out, and
 * that charge may already have been recorded.
 */
async function chargeFetchOnce(request: Request<ContentCrawlerUserData>, crawlerType: ContentCrawlerTypes) {
    if (request.userData.isFetchChargeAttempted) return;

    request.userData.isFetchChargeAttempted = true;
    await chargeFetch(crawlerType, {
        actorRequestId: request.userData.actorRequestId,
        idempotencyKey: request.uniqueKey,
    });
}

/**
 * Hands a finished page to the response it belongs to.
 *
 * Only called once the page has been charged for: a response completes as soon as none of its pages
 * are pending, so registering earlier would let a sibling send the response while this page's charge
 * is still in flight, and the platform refuses a charge whose request is gone.
 */
function completeContentRequest(request: Request<ContentCrawlerUserData>, result: Output) {
    const { responseId } = request.userData;

    addResultToResponse(responseId, request.uniqueKey, result);
    sendResponseIfFinished(responseId);
}

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
            const result = await requestHandlerPlaywright(typedContext, blocker);
            await chargeFetchOnce(typedContext.request, ContentCrawlerTypes.PLAYWRIGHT);
            completeContentRequest(typedContext.request, result);
        }),
        failedRequestHandler: async ({ request }, err) => {
            await failedRequestHandler(request, err, ContentCrawlerTypes.PLAYWRIGHT);
            sendResponseIfFinished(request.userData.responseId!);
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
        additionalMimeTypes: TEXT_DOCUMENT_CONTENT_TYPES,
        requestQueue: await RequestQueue.open(key, { storageClient: client }),
        requestHandler: (async (context) => {
            const typedContext = context as unknown as CheerioCrawlingContext<ContentCrawlerUserData>;
            const result = await requestHandlerCheerio(typedContext);
            await chargeFetchOnce(typedContext.request, ContentCrawlerTypes.CHEERIO);
            completeContentRequest(typedContext.request, result);
        }),
        failedRequestHandler: async ({ request }, err) => {
            await failedRequestHandler(request, err, ContentCrawlerTypes.CHEERIO);
            sendResponseIfFinished(request.userData.responseId!);
        },
    });
}

/**
 * Adds a search request to the search crawler identified by `searchCrawlerKey`.
 * Create a response for the request and set the desired number of results (maxResults).
 */
export const addSearchRequest = async (
    request: RequestOptions<ContentCrawlerUserData>,
    searchCrawlerKey: CrawlerKind,
) => {
    const crawlerPromise = crawlers.get(searchCrawlerKey);
    if (!crawlerPromise) {
        log.error(`Search crawler not found: ${searchCrawlerKey}`);
        sendResponseError(request.userData!.responseId, 'The search crawler is restarting. Please retry.');
        return;
    }

    const crawler = await crawlerPromise;
    addTimeMeasureEvent(request.userData!, 'before-cheerio-queue-add');
    await crawler.requestQueue!.addRequest(request);
    log.info(`Added request to cheerio-google-search-crawler: ${request.url}`);
};
