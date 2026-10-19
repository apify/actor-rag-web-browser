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
    NonRetryableError,
    PlaywrightCrawler,
    type PlaywrightCrawlerOptions,
    type PlaywrightCrawlingContext,
    type Request,
    type RequestOptions,
} from 'crawlee';

import { canAfford, chargeFetch, chargeSearch } from './charging.js';
import { ContentCrawlerTypes, GOOGLE_STANDARD_RESULTS_PER_PAGE } from './const.js';
import { deduplicateResults, resolveGoogleRedirectUrls, scrapeOrganicResults } from './google-search/google-extractors-urls.js';
import { getMiniActor } from './mini-actors.js';
import {
    failedRequestHandler,
    requestHandlerCheerio,
    requestHandlerPlaywright,
    TEXT_DOCUMENT_CONTENT_TYPES,
} from './request-handler.js';
import { addEmptyResultToResponse, addResultToResponse, sendResponseError, sendResponseIfFinished } from './responses.js';
import type { ContentCrawlerOptions, ContentCrawlerUserData, Output, SearchCrawlerUserData } from './types.js';
import { addTimeMeasureEvent, createRequest, createSearchRequest, isActorStandby } from './utils.js';

const crawlers = new Map<string, CheerioCrawler | PlaywrightCrawler>();
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

export function getCrawlerKey(crawlerOptions: CheerioCrawlerOptions | PlaywrightCrawlerOptions) {
    return JSON.stringify(crawlerOptions);
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
    const crawler = crawlers.get(contentCrawlerKey);
    const name = crawler instanceof PlaywrightCrawler ? 'playwright' : 'cheerio';

    if (!crawler) {
        log.error(`Content crawler not found: key ${contentCrawlerKey}`);
        return;
    }
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
    const key = getCrawlerKey(searchCrawlerOptions);
    if (crawlers.has(key)) {
        return { key, crawler: crawlers.get(key) };
    }

    log.info(`Creating new cheerio crawler with key ${key}`);
    const crawler = new CheerioCrawler({
        ...(searchCrawlerOptions as CheerioCrawlerOptions),
        requestQueue: await RequestQueue.open(key, { storageClient: client }),
        requestHandler: async ({ request, $: _$, body, addRequests }: CheerioCrawlingContext<SearchCrawlerUserData>) => {
            // NOTE: we need to cast this to fix `cheerio` type errors
            addTimeMeasureEvent(request.userData!, 'cheerio-request-handler-start');
            const $ = _$ as CheerioAPI;

            log.info(`Search-crawler requestHandler: Processing URL: ${request.url}`);

            if (request.userData.contentScraperSettings.debugMode && !isActorStandby()) {
                await Actor.setValue(`google-serp-${request.id}-${request.retryCount}`, body, { contentType: 'text/html; charset=utf-8' });
            }
            const organicResults = scrapeOrganicResults($);
            const resolvedResults = await resolveGoogleRedirectUrls(organicResults);

            // Destructure userData for easier access (pagination fields are initialized in createSearchRequest)
            const { collectedResults, currentPage, totalPages, maxResults, actorRequestId } = request.userData;

            // Charged for a page of results rather than for submitting the query, so a search Google
            // refuses stays free - but before anything is enqueued, or the response could beat the charge
            // and invalidate the caller's request ID. The flag rides along with the request, so a retry
            // of this handler cannot charge the query twice.
            if (resolvedResults.length > 0 && !request.userData.isSearchChargeAttempted) {
                if (!canAfford(getMiniActor().chargeEvents.search)) failUnaffordableRequest();
                request.userData.isSearchChargeAttempted = true;
                await chargeSearch({ actorRequestId, idempotencyKey: request.uniqueKey });
            }

            // Merge with previously collected results and deduplicate
            const allResults = [...collectedResults, ...resolvedResults];
            const deduplicated = deduplicateResults(allResults);

            log.info(`Page ${currentPage + 1}/${totalPages}: Extracted ${resolvedResults.length} results, Total unique: ${deduplicated.length}/${maxResults}`);

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
                    searchCrawlerOptions.proxyConfiguration,
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
    });
    if (startCrawler) {
        crawler.run().then(
            () => log.warning('Google-search-crawler has finished'),
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            () => { },
        );
        log.info('Google-search-crawler has started 🫡');
    }
    crawlers.set(key, crawler);
    log.info(`Number of crawlers ${crawlers.size}`);
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

    const key = getCrawlerKey(crawlerOptions);
    if (crawlers.has(key)) {
        return { key, crawler: crawlers.get(key) };
    }

    const crawler = crawlerType === 'playwright'
        ? await createPlaywrightContentCrawler(crawlerOptions, key)
        : await createCheerioContentCrawler(crawlerOptions, key);

    if (startCrawler) {
        crawler.run().then(
            () => log.warning(`Crawler ${crawlerType} has finished`),
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            () => { },
        );
        log.info(`Crawler ${crawlerType} has started 💪🏼`);
    }
    crawlers.set(key, crawler);
    log.info(`Number of crawlers ${crawlers.size}`);
    return { key, crawler };
}

function failUnaffordableRequest(): never {
    throw new NonRetryableError('The run has spent its maximum total charge.');
}

/** Pre-navigation hook, so a search the run cannot pay for never reaches Google. */
export function failUnaffordableSearch({ request }: { request: Request }) {
    // A query is charged once, however many result pages it spans, so only its first page needs the budget.
    if (!request.userData.isSearchChargeAttempted && !canAfford(getMiniActor().chargeEvents.search)) {
        failUnaffordableRequest();
    }
}

/** Pre-navigation hook, so a page the run cannot pay for is never fetched. */
export function failUnaffordableFetch(crawlerType: ContentCrawlerTypes) {
    return ({ request }: { request: Request }) => {
        // A retry of a page whose charge already went out needs no budget, as it is not charged again.
        if (!request.userData.isFetchChargeAttempted && !canAfford(getMiniActor().chargeEvents.fetch?.[crawlerType])) {
            failUnaffordableRequest();
        }
    };
}

async function chargeFetchOnce(request: Request<ContentCrawlerUserData>, crawlerType: ContentCrawlerTypes) {
    if (request.userData.isFetchChargeAttempted) return;

    request.userData.isFetchChargeAttempted = true;
    await chargeFetch(crawlerType, {
        actorRequestId: request.userData.actorRequestId,
        idempotencyKey: request.uniqueKey,
    });
}

/**
 * Stores a finished page in the dataset and hands it to the response it belongs to.
 *
 * Only called once the page has been charged for: a response completes as soon as none of its pages are
 * pending any more, so registering a page earlier would let a sibling finishing first send the response
 * while this page's charge is still in flight - and the platform refuses a charge whose request is gone.
 */
async function completeContentRequest(
    context: CheerioCrawlingContext<ContentCrawlerUserData> | PlaywrightCrawlingContext<ContentCrawlerUserData>,
    result: Output,
) {
    const { request } = context;
    const { responseId } = request.userData;

    log.info(`Adding result to the Apify dataset, url: ${request.url}`);
    await context.pushData(result);
    addResultToResponse(responseId, request.uniqueKey, result);
    sendResponseIfFinished(responseId);
}

async function createPlaywrightContentCrawler(
    crawlerOptions: PlaywrightCrawlerOptions,
    key: string,
): Promise<PlaywrightCrawler> {
    log.info(`Creating new playwright crawler with key ${key}`);
    const blocker = await getGhosteryBlocker();
    return new PlaywrightCrawler({
        ...crawlerOptions,
        keepAlive: crawlerOptions.keepAlive,
        requestQueue: await RequestQueue.open(key, { storageClient: client }),
        requestHandler: (async (context) => {
            const typedContext = context as unknown as PlaywrightCrawlingContext<ContentCrawlerUserData>;
            const { request } = typedContext;
            const { isFetchChargeAttempted } = request.userData;
            const fetchEvent = getMiniActor().chargeEvents.fetch?.[ContentCrawlerTypes.PLAYWRIGHT];
            const result = await requestHandlerPlaywright(typedContext, blocker);
            if (!isFetchChargeAttempted && !canAfford(fetchEvent)) failUnaffordableRequest();
            await chargeFetchOnce(request, ContentCrawlerTypes.PLAYWRIGHT);
            await completeContentRequest(typedContext, result);
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
    log.info(`Creating new cheerio crawler with key ${key}`);
    return new CheerioCrawler({
        ...crawlerOptions,
        keepAlive: crawlerOptions.keepAlive,
        httpClient: contentCrawlerHttpClient,
        additionalMimeTypes: TEXT_DOCUMENT_CONTENT_TYPES,
        requestQueue: await RequestQueue.open(key, { storageClient: client }),
        requestHandler: (async (context) => {
            const typedContext = context as unknown as CheerioCrawlingContext<ContentCrawlerUserData>;
            const { request } = typedContext;
            const { isFetchChargeAttempted } = request.userData;
            const fetchEvent = getMiniActor().chargeEvents.fetch?.[ContentCrawlerTypes.CHEERIO];
            const result = await requestHandlerCheerio(typedContext);
            if (!isFetchChargeAttempted && !canAfford(fetchEvent)) failUnaffordableRequest();
            await chargeFetchOnce(request, ContentCrawlerTypes.CHEERIO);
            await completeContentRequest(typedContext, result);
        }),
        failedRequestHandler: async ({ request }, err) => {
            await failedRequestHandler(request, err, ContentCrawlerTypes.CHEERIO);
            sendResponseIfFinished(request.userData.responseId!);
        },
    });
}

/**
 * Adds a search request to the Google search crawler.
 * Create a response for the request and set the desired number of results (maxResults).
 */
export const addSearchRequest = async (
    request: RequestOptions<ContentCrawlerUserData>,
    searchCrawlerOptions: CheerioCrawlerOptions,
) => {
    const key = getCrawlerKey(searchCrawlerOptions);
    const crawler = crawlers.get(key);

    if (!crawler) {
        log.error(`Cheerio crawler not found: key ${key}`);
        return;
    }
    addTimeMeasureEvent(request.userData!, 'before-cheerio-queue-add');
    await crawler.requestQueue!.addRequest(request);
    log.info(`Added request to cheerio-google-search-crawler: ${request.url}`);
};
