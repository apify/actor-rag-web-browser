import type { ProxyConfigurationOptions } from 'apify';
import type { CheerioCrawlerOptions, PlaywrightCrawlerOptions } from 'crawlee';

import type { ContentCrawlerTypes } from './const.js';

/**
 * Utility type to make specific properties of T optional.
 * @template T - The type to make properties optional
 * @template K - The keys of T to make optional
 */
type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type OutputFormats = 'text' | 'markdown' | 'html';
export type SERPProxyGroup = 'GOOGLE_SERP' | 'SHADER';
export type ScrapingTool = 'browser-playwright' | 'raw-http';

export type CommonInput = {
    debugMode: boolean;
    requestTimeoutSecs: number;

    // content crawler parameters
    dynamicContentWaitSecs: number;
    outputFormats: OutputFormats[];
    desiredConcurrency: number;
    maxRequestRetries: number;
    proxyConfiguration: ProxyConfigurationOptions;
    removeElementsCssSelector: string;
    htmlTransformer: string;
    removeCookieWarnings: boolean;
    scrapingTool: ScrapingTool;
};

export type UrlToMarkdownInput = CommonInput & {
    url: string;
};

export type RagWebBrowserInput = CommonInput & {
    maxResults: number;
    serpProxyGroup: SERPProxyGroup;
    serpMaxRetries: number;
    query: string;
};

export type Input = UrlToMarkdownInput | RagWebBrowserInput;

export type SearchResultType = 'ORGANIC' | 'SUGGESTED';

export type OrganicResult = {
    description?: string;
    title?: string;
    rank?: number;
    url?: string;
    resultType?: SearchResultType;
};

export interface TimeMeasure {
    event:
        | 'actor-started'
        | 'before-cheerio-queue-add'
        | 'before-cheerio-run'
        | 'before-playwright-queue-add'
        | 'before-playwright-run'
        | 'cheerio-request-start'
        | 'cheerio-failed-request'
        | 'cheerio-process-html'
        | 'cheerio-request-end'
        | 'cheerio-request-handler-start'
        | 'cheerio-before-response-send'
        | 'error'
        | 'playwright-request-start'
        | 'playwright-wait-dynamic-content'
        | 'playwright-parse-with-cheerio'
        | 'playwright-process-html'
        | 'playwright-remove-cookie'
        | 'playwright-before-response-send'
        | 'playwright-failed-request'
        | 'request-received';
    timeMs: number;
    timeDeltaPrevMs: number;
}

export interface ContentScraperSettings {
    debugMode: boolean;
    dynamicContentWaitSecs: number;
    htmlTransformer?: string
    maxHtmlCharsToProcess: number;
    outputFormats: OutputFormats[];
    removeCookieWarnings?: boolean;
    removeElementsCssSelector?: string;
}

export type SearchCrawlerUserData = {
    maxResults: number;
    timeMeasures: TimeMeasure[];
    query: string;
    contentCrawlerKey: string;
    responseId: string;
    contentScraperSettings: ContentScraperSettings;
    // Pagination tracking
    /** Results accumulated across SERP pages, passed forward for merging */
    collectedResults: OrganicResult[];
    /** Current page number (0-indexed) */
    currentPage: number;
    /** Max pages: ceil(maxResults/10) + 1 to handle pages with <10 results */
    totalPages: number;
};

/**
 * Type for createSearchRequest function parameters.
 * Makes pagination fields optional while keeping required fields mandatory.
 */
export type CreateSearchRequestUserData = Optional<SearchCrawlerUserData, 'timeMeasures' | 'collectedResults' | 'currentPage' | 'totalPages'>;

export type ContentCrawlerUserData = {
    query: string;
    responseId: string;
    timeMeasures: TimeMeasure[];
    searchResult?: OrganicResult;
    contentCrawlerKey?: string;
    contentScraperSettings: ContentScraperSettings;
};

export type Output = {
    text?: string | null;
    html?: string | null;
    markdown?: string | null;
    query?: string;
    crawl: {
        createdAt?: Date;
        httpStatusCode?: number | null;
        httpStatusMessage?: string | null;
        loadedAt?: Date;
        requestStatus: string;
        uniqueKey: string;
        debug?: unknown;
    };
    searchResult: OrganicResult;
    metadata: {
        title?: string | null;
        url: string;
        redirectedUrl?: string | null;
        description?: string | null;
        author?: string | null;
        languageCode?: string | null;
    };
};

export type ContentCrawlerOptions = {
    type: ContentCrawlerTypes.CHEERIO,
    crawlerOptions: CheerioCrawlerOptions
} | {
    type: ContentCrawlerTypes.PLAYWRIGHT,
    crawlerOptions: PlaywrightCrawlerOptions
};
