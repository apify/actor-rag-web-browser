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

export const PLAYWRIGHT_REQUEST_TIMEOUT_NORMAL_MODE_SECS = 60;

export const GOOGLE_STANDARD_RESULTS_PER_PAGE = 10;
