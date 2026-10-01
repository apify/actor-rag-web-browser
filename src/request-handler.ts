import type { IncomingHttpHeaders } from 'node:http';

import type { PlaywrightBlocker } from '@ghostery/adblocker-playwright';
import { Actor } from 'apify';
import { load } from 'cheerio';
import { type CheerioCrawlingContext, htmlToText, log, type PlaywrightCrawlingContext, type Request, sleep } from 'crawlee';

import { ContentCrawlerStatus, ContentCrawlerTypes } from './const.js';
import { blockMediaRequests, SKIPPED_MEDIA_FILE_MESSAGE } from './media.js';
import { addResultToResponse, responseData } from './responses.js';
import {
    decodeUtf8TextDocument,
    extractMarkdownTitle,
    isMarkdownDocument,
    isTextDocument,
    textDocumentToHtml,
} from './text-documents.js';
import type { ContentCrawlerUserData, Output } from './types.js';
import { addTimeMeasureEvent, isActorStandby, transformTimeMeasuresToRelative } from './utils.js';
import {
    extractCanonicalUrl,
    extractJsonLd,
    extractOpenGraphProperties,
    extractTitle,
    processHtml,
} from './website-content-crawler/html-processing.js';
import { htmlToMarkdown } from './website-content-crawler/markdown.js';

/** Same as the default of the `clickElementsCssSelector` input of Website Content Crawler. */
const CLICK_ELEMENTS_CSS_SELECTOR = '[aria-expanded="false"]';

const CLICK_RENDER_WAIT_MS = 500;

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

/**
 * Tries to expand collapsed content by clicking on it, so that its text is included in the extracted
 * content, e.g. https://www.checkout.com/docs/support/reporting (adapted from: Website Content Crawler).
 *
 * A click handler can still navigate the page with JavaScript, and then the content is extracted from
 * the page it navigated to, the same as in Website Content Crawler.
 */
async function expandClickableElements(page: PlaywrightCrawlingContext['page'], cssSelector: string) {
    const clickedCount = await page.evaluate((selector) => {
        // only click on items that don't have `href` attribute or they lead to the current page
        const elements = [...document.querySelectorAll(selector)].filter((el) => {
            const href = el.getAttribute('href');
            return (!href || href.startsWith('#')) && typeof (el as HTMLElement).click === 'function';
        });

        for (const el of elements) {
            (el as HTMLElement).click();
        }

        return elements.length;
    }, cssSelector);

    if (clickedCount > 0) {
        log.debug(`Clicked ${clickedCount} element(s) matching \`${cssSelector}\``);
        await sleep(CLICK_RENDER_WAIT_MS);
    }
}

type ContentCrawlingContext = PlaywrightCrawlingContext<ContentCrawlerUserData> | CheerioCrawlingContext<ContentCrawlerUserData>;

function isValidContentType(contentType: string | undefined) {
    return ['text', 'html', 'xml'].some((type) => contentType?.includes(type));
}

/** Playwright exposes the headers through a method, but the context types also allow a plain object. */
function getPlaywrightResponseHeaders(response: PlaywrightCrawlingContext['response']): IncomingHttpHeaders | undefined {
    if (!response) return undefined;

    const { headers }: { headers: IncomingHttpHeaders | (() => IncomingHttpHeaders) } = response;
    return typeof headers === 'function' ? response.headers() : headers;
}

/**
 * Stores an empty result for a page we haven't extracted any content from.
 */
async function pushSkippedResult(
    context: ContentCrawlingContext,
    httpStatusMessage: string,
    httpStatusCode?: number,
): Promise<Output> {
    const { request } = context;

    const resultSkipped: Output = {
        crawl: {
            httpStatusCode,
            httpStatusMessage,
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
    return resultSkipped;
}

/**
 * @returns The stored empty result when the response holds nothing we can parse, `undefined` when the
 * page can be processed after all.
 */
async function skipUnparsableResponse(
    $: CheerioCrawlingContext['$'],
    contentType: string | undefined,
    statusCode: number | undefined,
    context: ContentCrawlingContext,
): Promise<Output | undefined> {
    if (!$ || !isValidContentType(contentType)) {
        log.info(`Skipping URL ${context.request.loadedUrl} as it could not be parsed.`, { contentType });
        return pushSkippedResult(context, "Couldn't parse the content", statusCode);
    }

    return undefined;
}

/**
 * Stores the result of a page we have extracted the content from.
 */
async function pushHandledResult(
    context: ContentCrawlingContext,
    crawlerType: ContentCrawlerTypes,
    result: Output,
): Promise<Output> {
    const { request } = context;

    addTimeMeasureEvent(request.userData, `${crawlerType}-before-response-send`);
    if (request.userData.contentScraperSettings.debugMode) {
        // eslint-disable-next-line no-param-reassign
        result.crawl.debug = { timeMeasures: transformTimeMeasuresToRelative(request.userData.timeMeasures!) };
    }
    log.info(`Adding result to the Apify dataset, url: ${request.url}`);
    await context.pushData(result);
    return result;
}

async function handleContent(
    $: CheerioCrawlingContext['$'],
    crawlerType: ContentCrawlerTypes,
    statusCode: number | undefined,
    headers: IncomingHttpHeaders | undefined,
    context: PlaywrightCrawlingContext<ContentCrawlerUserData> | CheerioCrawlingContext<ContentCrawlerUserData>,
): Promise<Output> {
    const { request } = context;
    const { contentScraperSettings: settings } = request.userData;

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
            title: extractTitle($),
            description: $('meta[name=description]').first().attr('content') ?? undefined,
            keywords: $('meta[name=keywords]').first().attr('content') ?? undefined,
            languageCode: $html.first().attr('lang') ?? undefined,
            url: request.loadedUrl ?? request.url,
            redirectedUrl: request.loadedUrl,
            canonicalUrl: extractCanonicalUrl($, request.loadedUrl ?? request.url),
            openGraph: extractOpenGraphProperties($),
            jsonLd: extractJsonLd($),
            headers,
        },
        query: request.userData.query,
        text: settings.outputFormats.includes('text') ? text : undefined,
        markdown: settings.outputFormats.includes('markdown')
            ? htmlToMarkdown(processedHtml, request.loadedUrl ?? request.url)
            : undefined,
        html: settings.outputFormats.includes('html') ? processedHtml : undefined,
    };

    return pushHandledResult(context, crawlerType, result);
}

/**
 * Stores the body of a Markdown or plain text document as it is, since it is already in the form we
 * would convert a page to.
 */
async function handleTextDocument(
    body: string,
    contentType: string | undefined,
    crawlerType: ContentCrawlerTypes,
    statusCode: number | undefined,
    headers: IncomingHttpHeaders | undefined,
    context: ContentCrawlingContext,
): Promise<Output> {
    const { request } = context;
    const { contentScraperSettings: settings } = request.userData;
    // Unlike a browser, `Buffer#toString` keeps the byte order mark the document may start with.
    const text = body.startsWith('\uFEFF') ? body.slice(1) : body;

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
            title: isMarkdownDocument(contentType, request.loadedUrl ?? request.url) ? extractMarkdownTitle(text) : '',
            url: request.loadedUrl ?? request.url,
            redirectedUrl: request.loadedUrl,
            headers,
        },
        query: request.userData.query,
        text: settings.outputFormats.includes('text') ? text : undefined,
        markdown: settings.outputFormats.includes('markdown') ? text : undefined,
        html: settings.outputFormats.includes('html') ? textDocumentToHtml(text) : undefined,
    };

    return pushHandledResult(context, crawlerType, result);
}

/**
 * Tells the type of a document served without one, or revalidated in the browser cache (the response is then
 * 304 Not Modified, often without a type), by what the page shows. Only while the page shows the document of
 * the response, which a script could have replaced in the meantime.
 */
async function getUntypedDocumentType(
    { page, response }: PlaywrightCrawlingContext<ContentCrawlerUserData>,
): Promise<string | undefined> {
    const shown = await page.evaluate(() => ({ type: document.contentType, url: document.URL })).catch(() => undefined);
    if (!shown || (response && shown.url.split('#')[0] !== response.url().split('#')[0])) return undefined;

    return shown.type;
}

/**
 * Reads a document revalidated in the browser cache, which keeps its body, unlike the response to the
 * revalidation (304 Not Modified). A Content Security Policy of the document can prevent it.
 */
async function readCachedDocument(
    page: PlaywrightCrawlingContext['page'],
): Promise<{ body: Buffer, contentType?: string } | undefined> {
    const cached = await page.evaluate(async () => {
        const response = await fetch(document.URL, { cache: 'only-if-cached', mode: 'same-origin' });
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return { body: btoa(binary), contentType: response.headers.get('content-type') ?? undefined };
    }).catch(() => undefined);

    return cached && { body: Buffer.from(cached.body, 'base64'), contentType: cached.contentType };
}

/**
 * Reads a text document as the browser shows it, unless it's in UTF-8, see {@link decodeUtf8TextDocument}.
 * Then its body is needed, which the browser doesn't keep for a large one.
 */
async function readPlaywrightTextDocument(
    { page, response }: PlaywrightCrawlingContext<ContentCrawlerUserData>,
    contentType: string | undefined,
): Promise<string> {
    const served = response?.status() === 304
        ? await readCachedDocument(page)
        : await response?.body().then((body) => ({ body, contentType }), () => undefined);

    return (served && decodeUtf8TextDocument(served.body, served.contentType))
        ?? page.evaluate(() => document.body?.textContent ?? '');
}

/**
 * @returns The result for this page. The caller registers it with the response, once the page has been
 * charged for.
 */
export async function requestHandlerPlaywright(
    context: PlaywrightCrawlingContext<ContentCrawlerUserData>,
    blocker?: PlaywrightBlocker,
): Promise<Output> {
    const { request, response, page, closeCookieModals } = context;
    const { contentScraperSettings: settings, responseId } = request.userData;

    if (isActorStandby()) checkTimeoutAndCancelRequest(request, responseId);

    log.info(`Processing URL: ${request.url}`);
    addTimeMeasureEvent(request.userData, 'playwright-request-start');

    // Media file requests are created with `skipNavigation` (see `createRequest`), so there is no page to process.
    if (request.skipNavigation) {
        return pushSkippedResult(context, SKIPPED_MEDIA_FILE_MESSAGE);
    }

    const headers = getPlaywrightResponseHeaders(response);
    const contentType = headers?.['content-type'];
    const statusCode = response?.status();

    // The browser shows such a document as plain text, so there is nothing to wait for, close or expand.
    const documentType = contentType ?? await getUntypedDocumentType(context);
    if (isTextDocument(documentType)) {
        const body = await readPlaywrightTextDocument(context, contentType);
        return handleTextDocument(body, documentType, ContentCrawlerTypes.PLAYWRIGHT, statusCode, headers, context);
    }

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
                // The Ghostery blocker continues all the requests it doesn't block, which would take
                // precedence over the media blocking set up in the pre-navigation hook.
                await blockMediaRequests(page);
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

    if (page) {
        await expandClickableElements(page, CLICK_ELEMENTS_CSS_SELECTOR);
        addTimeMeasureEvent(request.userData, 'playwright-expand-clickable-elements');
    }

    // Parsing the page after the dynamic content has been loaded / cookie warnings removed
    const $ = await context.parseWithCheerio();
    addTimeMeasureEvent(request.userData, 'playwright-parse-with-cheerio');

    const skipped = await skipUnparsableResponse($, contentType, statusCode, context);
    if (skipped) return skipped;

    return handleContent($, ContentCrawlerTypes.PLAYWRIGHT, statusCode, headers, context);
}

/** @returns The result for this page, as in {@link requestHandlerPlaywright}. */
export async function requestHandlerCheerio(
    context: CheerioCrawlingContext<ContentCrawlerUserData>,
): Promise<Output> {
    const { $, body, contentType, request, response } = context;
    const { responseId } = request.userData;

    if (isActorStandby()) checkTimeoutAndCancelRequest(request, responseId);

    log.info(`Processing URL: ${request.url}`);
    addTimeMeasureEvent(request.userData, 'cheerio-request-start');

    // Media file requests are created with `skipNavigation` (see `createRequest`), so there is no response.
    if (request.skipNavigation) {
        return pushSkippedResult(context, SKIPPED_MEDIA_FILE_MESSAGE);
    }

    const { statusCode } = response;

    // Crawlee parses only HTML and XML, and hands over the body of any other content type as a buffer.
    // Its content type is also inferred from the URL extension when the server doesn't send one.
    if (isTextDocument(contentType.type)) {
        const text = typeof body === 'string' ? body : body.toString(contentType.encoding);
        return handleTextDocument(text, contentType.type, ContentCrawlerTypes.CHEERIO, statusCode, response.headers, context);
    }

    const skipped = await skipUnparsableResponse($, response.headers['content-type'], statusCode, context);
    if (skipped) return skipped;

    return handleContent($, ContentCrawlerTypes.CHEERIO, statusCode, response.headers, context);
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
    }
}
