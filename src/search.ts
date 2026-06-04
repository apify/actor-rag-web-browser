import type { IncomingMessage, ServerResponse } from 'node:http';

import { type CheerioCrawlerOptions, log } from 'crawlee';

import { PLAYWRIGHT_REQUEST_TIMEOUT_NORMAL_MODE_SECS, Routes } from './const.js';
import { addContentCrawlRequest, addSearchRequest, createAndStartContentCrawler, createAndStartSearchCrawler } from './crawlers.js';
import { UserInputError } from './errors.js';
import { MINIACTORS, processInput } from './input.js';
import { createResponsePromise } from './responses.js';
import type { ContentCrawlerOptions, ContentScraperSettings, Input, Output, RagWebBrowserInput, UrlToMarkdownInput } from './types.js';
import {
    addTimeMeasureEvent,
    createRequest,
    createSearchRequest,
    interpretAsUrl,
    parseParameters,
    randomId,
} from './utils.js';

/**
 * Prepares the request for the search.
 * Decide whether input.query is a URL or a search query. If it's a URL, we don't need to run the search crawler.
 * Return the request, isUrl and responseId.
 */
function prepareRequest(
    input: Input,
    searchCrawlerOptions: CheerioCrawlerOptions,
    contentCrawlerKey: string,
    contentScraperSettings: ContentScraperSettings,
    selectedMiniActor: typeof MINIACTORS[keyof typeof MINIACTORS],
) {
    if (selectedMiniActor === MINIACTORS.URL_TO_MARKDOWN) {
        const responseId = randomId();
        const { url } = (input as Input & UrlToMarkdownInput);
        const req = createRequest(
            url,
            { url },
            responseId,
            contentScraperSettings,
            null,
        );
        addTimeMeasureEvent(req.userData!, 'request-received', Date.now());
        return { req, isUrl: true, responseId };
    }

    const { query, maxResults } = input as Input & RagWebBrowserInput;
    const interpretedUrl = interpretAsUrl(query);
    const validatedQuery = interpretedUrl ?? query;
    const responseId = randomId();

    const req = interpretedUrl
        ? createRequest(
            validatedQuery,
            { url: validatedQuery },
            responseId,
            contentScraperSettings,
            null,
        )
        : createSearchRequest(
            {
                query: validatedQuery,
                responseId,
                maxResults,
                contentCrawlerKey,
                contentScraperSettings,
            },
            searchCrawlerOptions.proxyConfiguration,
        );

    addTimeMeasureEvent(req.userData!, 'request-received', Date.now());
    return { req, isUrl: !!interpretedUrl, responseId };
}

/**
 * Internal function that handles the common logic for search.
 * Returns a promise that resolves to the final results array of Output objects.
 */
async function runSearchProcess(params: Partial<Input>): Promise<Output[]> {
    // Process the query parameters the same way as normal inputs
    const {
        input,
        searchCrawlerOptions,
        contentCrawlerOptions,
        contentScraperSettings,
        selectedMiniActor,
    } = await processInput(params);

    // Set keepAlive to true to find the correct crawlers
    searchCrawlerOptions.keepAlive = true;
    contentCrawlerOptions.crawlerOptions.keepAlive = true;

    const { key: contentCrawlerKey } = await createAndStartContentCrawler(contentCrawlerOptions);

    const { req, isUrl, responseId } = prepareRequest(
        input,
        searchCrawlerOptions,
        contentCrawlerKey,
        contentScraperSettings,
        selectedMiniActor,
    );

    // Create a promise that resolves when all requests are processed
    const resultsPromise = createResponsePromise(responseId, input.requestTimeoutSecs);

    if (isUrl) {
        // If input is a direct URL, skip the search crawler
        if (selectedMiniActor === MINIACTORS.RAG_WEB_BROWSER) {
            const { query } = (input as Input & RagWebBrowserInput);
            log.info(`Skipping Google Search query as "${query}" is a valid URL`);
        }
        await addContentCrawlRequest(req, responseId, contentCrawlerKey);
    } else {
        await createAndStartSearchCrawler(searchCrawlerOptions);
        // If input is a search query, run the search crawler first
        await addSearchRequest(req, searchCrawlerOptions);
    }

    // Return promise that resolves when all requests are processed
    return resultsPromise;
}

/**
 * Handles the search request at the /search endpoint (HTTP scenario).
 * Uses the unified runSearchProcess function and then sends an HTTP response.
 */
export async function handleSearchRequest(request: IncomingMessage, response: ServerResponse) {
    try {
        const params = parseParameters(request.url?.slice(Routes.SEARCH.length) ?? '');
        log.info(`Received query parameters: ${JSON.stringify(params)}`);

        const results = await runSearchProcess(params);

        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(results));
    } catch (e) {
        const error = e as Error;
        const statusCode = error instanceof UserInputError ? 400 : 500;
        log.error(`Error occurred: ${error.message}`);
        response.writeHead(statusCode, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ errorMessage: error.message }));
    }
}

/**
 * Handles the model context protocol scenario (non-HTTP scenario).
 * Uses the same runSearchProcess function but just returns the results as a promise.
 */
export async function handleModelContextProtocol(params: Partial<Input>): Promise<Output[]> {
    try {
        log.info(`Received parameters: ${JSON.stringify(params)}`);
        return await runSearchProcess(params);
    } catch (e) {
        const error = e as Error;
        log.error(`UserInputError occurred: ${error.message}`);
        return [{ text: error.message }] as Output[];
    }
}

/**
 * Runs the search and scrape in normal mode.
 */
export async function handleSearchNormalMode(
    input: Input,
    searchCrawlerOptions: CheerioCrawlerOptions,
    contentCrawlerOptions: ContentCrawlerOptions,
    contentScraperSettings: ContentScraperSettings,
    selectedMiniActor: typeof MINIACTORS[keyof typeof MINIACTORS],

) {
    /* eslint-disable no-param-reassign */
    const startedTime = Date.now();
    contentCrawlerOptions.crawlerOptions.requestHandlerTimeoutSecs = PLAYWRIGHT_REQUEST_TIMEOUT_NORMAL_MODE_SECS;

    const {
        crawler: contentCrawler,
        key: contentCrawlerKey,
    } = await createAndStartContentCrawler(contentCrawlerOptions, false);

    const { req, isUrl } = prepareRequest(
        input,
        searchCrawlerOptions,
        contentCrawlerKey,
        contentScraperSettings,
        selectedMiniActor,
    );
    if (isUrl) {
        if (selectedMiniActor === MINIACTORS.RAG_WEB_BROWSER) {
            // If the input query is a URL, we don't need to run the search crawler
            const { query } = (input as Input & RagWebBrowserInput);
            log.info(`Skipping Google Search query as "${query}" is a valid URL`);
        }
        await addContentCrawlRequest(req, '', contentCrawlerKey);
    } else {
        const { crawler: searchCrawler } = await createAndStartSearchCrawler(searchCrawlerOptions, false);
        await addSearchRequest(req, searchCrawlerOptions);
        addTimeMeasureEvent(req.userData!, 'before-cheerio-run', startedTime);
        log.info(`Running Google Search crawler with request: ${JSON.stringify(req)}`);
        await searchCrawler!.run();
    }

    addTimeMeasureEvent(req.userData!, 'before-playwright-run', startedTime);
    log.info(`Running target page crawler with request: ${JSON.stringify(req)}`);
    await contentCrawler!.run();
    /* eslint-enable no-param-reassign */

    const { requestsFinished, requestsFailed } = contentCrawler!.stats.state;
    return { requestsFinished, requestsFailed };
}
