import { log } from 'apify';
import type { RequestOptions } from 'crawlee';

import { ContentCrawlerStatus } from './const.js';
import type { ContentCrawlerUserData, Output } from './types.js';

type ResponseData = {
    resultsMap: Map<string, Output>;
    resolve: (value: Output[]) => void;
    reject: (reason?: unknown) => void;
    timeoutId?: NodeJS.Timeout;
};

export const responseData = new Map<string, ResponseData>();

/**
 * Helper function to get response object by responseId.
 */
const getResponse = (responseId: string): ResponseData | null => {
    const res = responseData.get(responseId);
    if (res) return res;

    return null;
};

/**
 * Create a response promise
 * (for content crawler requests there is no need to create a response object).
 */
export async function createResponsePromise(responseId: string, timeoutSecs: number): Promise<Output[]> {
    log.info(`Created responsePromise for response ID: ${responseId}`);
    return new Promise<Output[]>((resolve, reject) => {
        const data: ResponseData = {
            resultsMap: new Map<string, Output>(),
            resolve,
            reject,
        };
        responseData.set(responseId, data);

        // Set a timeout to reject the promise if it takes too long
        data.timeoutId = setTimeout(() => {
            sendResponseError(responseId, 'Timed out.');
        }, timeoutSecs * 1000);
    });
}

/**
 * Add empty result to response object when the content crawler request is created.
 * This is needed to keep track of all results and to know that all results have been handled.
 */
export function addEmptyResultToResponse(responseId: string, request: RequestOptions<ContentCrawlerUserData>) {
    const res = getResponse(responseId);
    if (!res) return;

    const result: Partial<Output> = {
        searchResult: request.userData?.searchResult,
        metadata: { url: request.url },
        crawl: { createdAt: new Date(), requestStatus: ContentCrawlerStatus.PENDING, uniqueKey: request.uniqueKey! },
    };
    res.resultsMap.set(request.uniqueKey!, result as Output);
}

export function addResultToResponse(responseId: string, uniqueKey: string, result: Output) {
    const res = getResponse(responseId);
    if (!res) return;

    const existing = res.resultsMap.get(uniqueKey);
    if (!existing) {
        log.info(`Result for request ${result.metadata.url} (key: ${uniqueKey}) not found in response ${responseId}`);
        return;
    }
    res.resultsMap.set(uniqueKey, { ...existing, ...result });
    log.info(`Updated response ${responseId} with a result from ${result.metadata.url}`);
}

export function sendResponseOk(responseId: string, result: string | Output[]) {
    const res = getResponse(responseId);
    if (!res) return;

    if (res.timeoutId) clearTimeout(res.timeoutId);

    let parsedResults: Output[];
    if (typeof result === 'string') {
        parsedResults = JSON.parse(result) as Output[];
    } else {
        parsedResults = result as Output[];
    }

    res.resolve(parsedResults);
    log.info(`Response ${responseId} resolved successfully with ${parsedResults.length} results.`);
    responseData.delete(responseId);
}

/**
 * Check if all results have been handled. It is used to determine if the response can be sent.
 */
function checkAllResultsHandled(responseId: string): boolean {
    const res = getResponse(responseId);
    if (!res) return false;

    for (const value of res.resultsMap.values()) {
        if (value.crawl.requestStatus === ContentCrawlerStatus.PENDING) {
            return false;
        }
    }
    return true;
}

/**
 * Sort results by rank.
 */
function sortResultsByRank(res: ResponseData): Output[] {
    const resultsArray = Array.from(res.resultsMap.values());
    resultsArray.sort((a, b) => {
        const ra = a.searchResult.rank ?? Infinity;
        const rb = b.searchResult.rank ?? Infinity;
        return ra - rb;
    });
    return resultsArray;
}

/**
 * Send response with error status code. If the response contains some handled requests,
 * return 200 status otherwise 500.
 */
export function sendResponseError(responseId: string, message: string) {
    const res = getResponse(responseId);
    if (!res) return;

    if (res.timeoutId) clearTimeout(res.timeoutId);

    let returnStatus = 500;
    for (const [key, val] of res.resultsMap) {
        if (val.crawl.requestStatus === ContentCrawlerStatus.PENDING) {
            val.crawl.httpStatusCode = 500;
            val.crawl.httpStatusMessage = message;
            val.crawl.requestStatus = ContentCrawlerStatus.FAILED;
            val.metadata.title = '';
            val.text = '';
        } else if (val.crawl.requestStatus === ContentCrawlerStatus.HANDLED) {
            returnStatus = 200;
        }
        res.resultsMap.set(key, val);
    }
    if (returnStatus === 200) {
        log.warning(`Response for request ${responseId} has been sent with partial results`);
        res.resolve(sortResultsByRank(res));
    } else {
        log.error(`Response for request ${responseId} has been sent with error: ${message}`);
        res.reject(new Error(message));
    }
    responseData.delete(responseId);
}

/**
 * Send response if all results have been handled or failed.
 */
export function sendResponseIfFinished(responseId: string) {
    const res = getResponse(responseId);
    if (!res) return;

    if (checkAllResultsHandled(responseId)) {
        sendResponseOk(responseId, sortResultsByRank(res));
    }
}

/**
 * Tells everyone still waiting that this run is moving to another server, so they retry instead of
 * waiting out their own timeout. Sent at once rather than on a timer, because the announcement is
 * the last moment we know the process is still here to answer with.
 */
export function failAllResponsesOnMigration() {
    for (const responseId of [...responseData.keys()]) {
        sendResponseError(responseId, 'Actor had to migrate to another server. Please, retry your request.');
    }
}
