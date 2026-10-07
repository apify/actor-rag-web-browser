export enum ContentCrawlerStatus {
    PENDING = 'pending',
    HANDLED = 'handled',
    FAILED = 'failed',
}

export enum Routes {
    SEARCH = '/search',
    SSE = '/sse',
    MESSAGE = '/message',

    // Same as SEARCH, but only for url-to-markdown mini-actor
    FETCH = '/fetch',
}

export enum ContentCrawlerTypes {
    PLAYWRIGHT = 'playwright',
    CHEERIO = 'cheerio',
}

export type CrawlerKind = 'search' | ContentCrawlerTypes;

/**
 * The widest the input schemas allow, because the shared crawlers cannot be built from one request's
 * input. A request carries its own retry count on `Request.maxRetries` and its own timeout on the
 * response promise, so the handler timeout is only a backstop against a wedged handler.
 */
export const CRAWLER_MAX_REQUEST_RETRIES = 5;
export const CRAWLER_REQUEST_HANDLER_TIMEOUT_SECS = 300;

export const PLAYWRIGHT_REQUEST_TIMEOUT_NORMAL_MODE_SECS = 60;

export const GOOGLE_STANDARD_RESULTS_PER_PAGE = 10;

/** Reserved key-value store key holding an advisory message about the run. */
export const TIP_KVS_KEY = 'TIP';
