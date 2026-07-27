import type { PlaywrightBlocker } from '@ghostery/adblocker-playwright';
import { Actor } from 'apify';
import { load } from 'cheerio';
import { type CheerioCrawlingContext, htmlToText, log, type PlaywrightCrawlingContext, type Request, sleep } from 'crawlee';

import { ContentCrawlerStatus, ContentCrawlerTypes } from './const.js';
import { addResultToResponse, responseData, sendResponseIfFinished } from './responses.js';
import type { ContentCrawlerUserData, Output } from './types.js';
import { addTimeMeasureEvent, isActorStandby, transformTimeMeasuresToRelative } from './utils.js';
import { processHtml } from './website-content-crawler/html-processing.js';
import { htmlToMarkdown } from './website-content-crawler/markdown.js';

let ACTOR_TIMEOUT_AT: number | undefined;
try {
    ACTOR_TIMEOUT_AT = process.env.ACTOR_TIMEOUT_AT ? new Date(process.env.ACTOR_TIMEOUT_AT).getTime() : undefined;
} catch {
    ACTOR_TIMEOUT_AT = undefined;
}

/**
 * Waits for the `time` to pass, but breaks early if the page is loaded (source: Website Content Crawler).
 */
async function waitForPlaywright({ page }: PlaywrightCrawlingContext, time: number) {
    // Early break is possible only after 1/3 of the time has passed (max 3 seconds) to avoid breaking too early.
    const hardDelay = Math.min(1000, Math.floor(0.3 * time));
    await sleep(hardDelay);

    return Promise.race([page.waitForLoadState('networkidle', { timeout: 0 }), sleep(time - hardDelay)]);
}

/**
 * Checks if the request should time out based on response timeout.
 * It verifies if the response data contains the responseId. If not, it sets the request's noRetry flag
 * to true and throws an error to cancel the request.
 *
 * @param {Request} request - The request object to be checked.
 * @param {string} responseId - The response ID to look for in the response data.
 * @throws {Error} Throws an error if the request times out.
 */
function checkTimeoutAndCancelRequest(request: Request, responseId: string) {
    if (!responseData.has(responseId)) {
        request.noRetry = true;
        throw new Error('Timed out. Cancelling the request...');
    }
}

/**
 * Decide whether to wait based on the remaining time left for the Actor to run.
 * Always waits if the Actor is in the STANDBY_MODE.
 */
export function hasTimeLeftToTimeout(time: number) {
    if (process.env.STANDBY_MODE) return true;
    if (!ACTOR_TIMEOUT_AT) return true;

    const timeLeft = ACTOR_TIMEOUT_AT - Date.now();
    if (timeLeft > time) return true;

    log.debug('Not enough time left to wait for dynamic content. Skipping');
    return false;
}

/**
 * Waits for the `time`, but checks the content length every half second and breaks early if it hasn't changed
 * in last 2 seconds (source: Website Content Crawler).
 */
export async function waitForDynamicContent(context: PlaywrightCrawlingContext, time: number) {
    if (context.page && hasTimeLeftToTimeout(time)) {
        await waitForPlaywright(context, time);
    }
}

function isValidContentType(contentType: string | undefined) {
    return ['text', 'html', 'xml'].some((type) => contentType?.includes(type));
}

async function checkValidResponse(
    $: CheerioCrawlingContext['$'],
    contentType: string | undefined,
    context: PlaywrightCrawlingContext<ContentCrawlerUserData> | CheerioCrawlingContext<ContentCrawlerUserData>,
) {
    const { request, response } = context;
    const { responseId } = request.userData;

    if (!$ || !isValidContentType(contentType)) {
        log.info(`Skipping URL ${request.loadedUrl} as it could not be parsed.`, { contentType });
        const resultSkipped: Output = {
            crawl: {
                httpStatusCode: response?.status(),
                httpStatusMessage: "Couldn't parse the content",
                loadedAt: new Date(),
                uniqueKey: request.uniqueKey,
                requestStatus: ContentCrawlerStatus.FAILED,
            },
            metadata: { url: request.url },
            searchResult: request.userData.searchResult!,
            query: request.userData.query,
            text: '',
        };
        log.info(`Adding result to the Apify dataset, url: ${request.url}`);
        await context.pushData(resultSkipped);
        if (responseId) {
            addResultToResponse(responseId, request.uniqueKey, resultSkipped);
            sendResponseIfFinished(responseId);
        }
        return false;
    }

    return true;
}

async function handleContent(
    $: CheerioCrawlingContext['$'],
    crawlerType: ContentCrawlerTypes,
    statusCode: number | undefined,
    context: PlaywrightCrawlingContext<ContentCrawlerUserData> | CheerioCrawlingContext<ContentCrawlerUserData>,
) {
    const { request } = context;
    const { responseId, contentScraperSettings: settings } = request.userData;

    const $html = $('html');
    const html = $html.html()!;
    const processedHtml = await processHtml(html, request.url, settings, $);
    addTimeMeasureEvent(request.userData, `${crawlerType}-process-html`);

    const isTooLarge = processedHtml.length > settings.maxHtmlCharsToProcess;
    const text = isTooLarge ? load(processedHtml).text() : htmlToText(load(processedHtml).html());

    const result: Output = {
        crawl: {
            httpStatusCode: statusCode,
            httpStatusMessage: 'OK',
            loadedAt: new Date(),
            uniqueKey: request.uniqueKey,
            requestStatus: ContentCrawlerStatus.HANDLED,
        },
        searchResult: request.userData.searchResult!,
        metadata: {
            author: $('meta[name=author]').first().attr('content') ?? undefined,
            title: $('title').first().text(),
            description: $('meta[name=description]').first().attr('content') ?? undefined,
            languageCode: $html.first().attr('lang') ?? undefined,
            url: request.url,
            redirectedUrl: request.loadedUrl,
        },
        query: request.userData.query,
        text: settings.outputFormats.includes('text') ? text : undefined,
        markdown: settings.outputFormats.includes('markdown')
            ? htmlToMarkdown(processedHtml, request.loadedUrl ?? request.url)
            : undefined,
        html: settings.outputFormats.includes('html') ? processedHtml : undefined,
    };

    addTimeMeasureEvent(request.userData, `${crawlerType}-before-response-send`);
    if (settings.debugMode) {
        result.crawl.debug = { timeMeasures: transformTimeMeasuresToRelative(request.userData.timeMeasures!) };
    }
    log.info(`Adding result to the Apify dataset, url: ${request.url}`);
    await context.pushData(result);

    // Get responseId from the request.userData, which corresponds to the original search request
    if (responseId) {
        addResultToResponse(responseId, request.uniqueKey, result);
        sendResponseIfFinished(responseId);
    }
}

export async function requestHandlerPlaywright(
    context: PlaywrightCrawlingContext<ContentCrawlerUserData>,
    blocker?: PlaywrightBlocker,
) {
    const { request, response, page, closeCookieModals } = context;
    const { contentScraperSettings: settings, responseId } = request.userData;

    if (isActorStandby()) checkTimeoutAndCancelRequest(request, responseId);

    log.info(`Processing URL: ${request.url}`);
    addTimeMeasureEvent(request.userData, 'playwright-request-start');
    if (settings.dynamicContentWaitSecs > 0) {
        await waitForDynamicContent(context, settings.dynamicContentWaitSecs * 1000);
        addTimeMeasureEvent(request.userData, 'playwright-wait-dynamic-content');
    }

    if (page && settings.removeCookieWarnings) {
        // First try Ghostery blocker
        if (blocker) {
            try {
                await blocker.enableBlockingInPage(page);
                log.debug('Ghostery blocker enabled');
            } catch (err) {
                log.debug(`Ghostery blocker failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        // Then fall back to closeCookieModals as additional cleanup
        try {
            await closeCookieModals();
            log.debug('closeCookieModals executed as fallback');
        } catch (err) {
            log.debug(`closeCookieModals failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        addTimeMeasureEvent(request.userData, 'playwright-remove-cookie');
    }

    // Parsing the page after the dynamic content has been loaded / cookie warnings removed
    const $ = await context.parseWithCheerio();
    addTimeMeasureEvent(request.userData, 'playwright-parse-with-cheerio');

    const headers = response?.headers instanceof Function ? response.headers() : response?.headers;
    // @ts-expect-error false-positive?
    const isValidResponse = await checkValidResponse($, headers?.['content-type'], context);
    if (!isValidResponse) return;

    const statusCode = response?.status();

    await handleContent($, ContentCrawlerTypes.PLAYWRIGHT, statusCode, context);
}

export async function requestHandlerCheerio(
    context: CheerioCrawlingContext<ContentCrawlerUserData>,
) {
    const { $, request, response } = context;
    const { responseId } = request.userData;

    if (isActorStandby()) checkTimeoutAndCancelRequest(request, responseId);

    log.info(`Processing URL: ${request.url}`);
    addTimeMeasureEvent(request.userData, 'cheerio-request-start');

    const isValidResponse = await checkValidResponse($, response.headers['content-type'], context);
    if (!isValidResponse) return;

    const statusCode = response?.statusCode;

    await handleContent($, ContentCrawlerTypes.CHEERIO, statusCode, context);
}

export async function failedRequestHandler(request: Request, err: Error, crawlerType: ContentCrawlerTypes) {
    log.error(`Content-crawler failed to process request ${request.url}, error ${err.message}`);
    request.userData.timeMeasures!.push({ event: `${crawlerType}-failed-request`, time: Date.now() });
    const { responseId } = request.userData;
    if (responseId) {
        const resultErr: Output = {
            crawl: {
                httpStatusCode: 500,
                httpStatusMessage: err.message,
                loadedAt: new Date(),
                uniqueKey: request.uniqueKey,
                requestStatus: ContentCrawlerStatus.FAILED,
            },
            searchResult: request.userData.searchResult!,
            metadata: {
                url: request.url,
                title: '',
            },
            text: '',
        };
        log.info(`Adding result to the Apify dataset, url: ${request.url}`);
        await Actor.pushData(resultErr);
        addResultToResponse(responseId, request.uniqueKey, resultErr);
        sendResponseIfFinished(responseId);
    }
}
