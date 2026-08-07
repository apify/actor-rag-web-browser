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

export const PLAYWRIGHT_REQUEST_TIMEOUT_NORMAL_MODE_SECS = 60;

// The widest values the input schema allows; each request narrows them down to its own.
export const CRAWLER_MAX_REQUEST_RETRIES = 5;
export const CRAWLER_REQUEST_HANDLER_TIMEOUT_SECS = 300;

export const GOOGLE_STANDARD_RESULTS_PER_PAGE = 10;
