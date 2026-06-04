import type { ProxyConfigurationOptions } from 'apify';
import { Actor } from 'apify';
import type { CheerioCrawlerOptions, ProxyConfiguration } from 'crawlee';
import { BrowserName, log } from 'crawlee';
import { firefox } from 'playwright';

import ragWebBrowserInputSchema from '../actors/apify_rag-web-browser/.actor/input_schema.json' with { type: 'json' };
import { ContentCrawlerTypes } from './const.js';
import { UserInputError } from './errors.js';
import type {
    ContentCrawlerOptions,
    ContentScraperSettings,
    Input,
    OutputFormats,
    RagWebBrowserInput,
    ScrapingTool,
    SERPProxyGroup,
    UrlToMarkdownInput,
} from './types.js';
import { interpretAsUrl } from './utils.js';

export const MINIACTORS = {
    RAG_WEB_BROWSER: 'apify_rag-web-browser',
    URL_TO_MARKDOWN: 'apify_url-to-markdown',
};

/**
 * Processes the input and returns an array of crawler settings. This is ideal for startup of STANDBY mode
 * because it makes it simple to start all crawlers at once.
 */
export async function processStandbyInput(originalInput: Partial<Input>) {
    const selectedMiniActor = process.env.ACTOR_PATH_IN_DOCKER_CONTEXT?.split('/')[1];
    const { input, searchCrawlerOptions, contentScraperSettings } = await processInputInternal(originalInput, selectedMiniActor, true);

    const proxy = await Actor.createProxyConfiguration(input.proxyConfiguration);
    const contentCrawlerOptions: ContentCrawlerOptions[] = [
        createPlaywrightCrawlerOptions(input, proxy),
        createCheerioCrawlerOptions(input, proxy),
    ];

    return { input, searchCrawlerOptions, contentCrawlerOptions, contentScraperSettings, selectedMiniActor };
}

/**
 * Processes the input and returns the settings for the crawler.
 */
export async function processInput(originalInput: Partial<Input>) {
    const selectedMiniActor = process.env.ACTOR_PATH_IN_DOCKER_CONTEXT?.split('/')[1];
    const { input, searchCrawlerOptions, contentScraperSettings } = await processInputInternal(originalInput, selectedMiniActor);

    const proxy = await Actor.createProxyConfiguration(input.proxyConfiguration);
    const contentCrawlerOptions: ContentCrawlerOptions = input.scrapingTool === 'raw-http'
        ? createCheerioCrawlerOptions(input, proxy, false)
        : createPlaywrightCrawlerOptions(input, proxy, false);

    return { input, searchCrawlerOptions, contentCrawlerOptions, contentScraperSettings, selectedMiniActor: selectedMiniActor! };
}

/**
 * Processes the input and returns the settings for the crawler (adapted from: Website Content Crawler).
 */
async function processInputInternal(
    originalInput: Partial<Input>,
    selectedMiniActor: typeof MINIACTORS[keyof typeof MINIACTORS] | undefined,
    standbyInit = false,
) {
    // const input = { ...defaults, ...originalInput } as Input;
    let input: Input;
    let searchCrawlerOptions: CheerioCrawlerOptions = {};

    if (selectedMiniActor === MINIACTORS.RAG_WEB_BROWSER) {
        const processedRagWebBrowserInput = await processRagWebBrowserInput(
            originalInput as Partial<RagWebBrowserInput>, standbyInit);
        input = processedRagWebBrowserInput.validatedRagBrowserInput;
        searchCrawlerOptions = processedRagWebBrowserInput.searchCrawlerOptions;
    } else if (selectedMiniActor === MINIACTORS.URL_TO_MARKDOWN) {
        input = await processUrlToMarkdownInput(originalInput as Partial<UrlToMarkdownInput>);
    } else {
        log.warning('The ACTOR_PATH_IN_DOCKER_CONTEXT environment variable is not set to a known value. Please report to the developers.');
        throw await Actor.fail();
    }

    const {
        debugMode,
        dynamicContentWaitSecs,
        outputFormats,
        removeElementsCssSelector,
        htmlTransformer,
        removeCookieWarnings,
    } = input;

    log.setLevel(debugMode ? log.LEVELS.DEBUG : log.LEVELS.INFO);

    const contentScraperSettings: ContentScraperSettings = {
        debugMode,
        dynamicContentWaitSecs,
        htmlTransformer,
        maxHtmlCharsToProcess: 1.5e6,
        outputFormats,
        removeCookieWarnings,
        removeElementsCssSelector,
    };

    return { input, searchCrawlerOptions, contentScraperSettings };
}

async function processRagWebBrowserInput(input: Partial<RagWebBrowserInput>, standbyInit: boolean):
    Promise<{
        validatedRagBrowserInput: RagWebBrowserInput;
        searchCrawlerOptions: CheerioCrawlerOptions
    }> {
    /* eslint-disable no-param-reassign */

    // Throw an error if the query and is not provided and standbyInit is false.
    if (!input.query && !standbyInit) {
        throw new UserInputError('The `query` parameter must be provided and non-empty.');
    }

    // Max results
    input.maxResults = validateRange(
        input.maxResults,
        ragWebBrowserInputSchema.properties.maxResults.minimum,
        ragWebBrowserInputSchema.properties.maxResults.maximum,
        ragWebBrowserInputSchema.properties.maxResults.default,
        'maxResults',
    );

    // Output formats
    if (!input.outputFormats || input.outputFormats.length === 0) {
        input.outputFormats = ragWebBrowserInputSchema.properties.outputFormats.default as OutputFormats[];
        log.info(`The \`outputFormats\` parameter is not defined. Using default value \`${input.outputFormats}\`.`);
    } else if (input.outputFormats.some((format) => !['text', 'markdown', 'html'].includes(format))) {
        throw new UserInputError('The `outputFormats` array may only contain `text`, `markdown`, or `html`.');
    }

    // SERP proxy group
    if (!input.serpProxyGroup || input.serpProxyGroup.length === 0) {
        input.serpProxyGroup = ragWebBrowserInputSchema.properties.serpProxyGroup.default as SERPProxyGroup;
    } else if (input.serpProxyGroup !== 'GOOGLE_SERP' && input.serpProxyGroup !== 'SHADER') {
        throw new UserInputError('The `serpProxyGroup` parameter must be either `GOOGLE_SERP` or `SHADER`.');
    }

    // SERP max retries
    input.serpMaxRetries = validateRange(
        input.serpMaxRetries,
        ragWebBrowserInputSchema.properties.serpMaxRetries.minimum,
        ragWebBrowserInputSchema.properties.serpMaxRetries.maximum,
        ragWebBrowserInputSchema.properties.serpMaxRetries.default,
        'serpMaxRetries',
    );

    const proxySearch = await Actor.createProxyConfiguration({ groups: [input.serpProxyGroup] });
    const searchCrawlerOptions: CheerioCrawlerOptions = {
        keepAlive: standbyInit,
        maxRequestRetries: input.serpMaxRetries,
        proxyConfiguration: proxySearch,
        autoscaledPoolOptions: { desiredConcurrency: 1 },
    };
    const validatedRagBrowserInput = validateAndFillInput(input) as RagWebBrowserInput;
    return {
        validatedRagBrowserInput,
        searchCrawlerOptions,
    };
    /* eslint-enable no-param-reassign */
}

async function processUrlToMarkdownInput(input: Partial<UrlToMarkdownInput>): Promise<UrlToMarkdownInput> {
    if (!input.url) {
        throw new UserInputError('The `url` parameter must be provided and non-empty.');
    }
    const interpretedUrl = interpretAsUrl(input.url);
    if (!interpretedUrl) {
        throw new UserInputError('The `url` parameter must be a valid URL or a string that can be interpreted as a URL.');
    }
    // We default to the only supported output format for this mini-actor, no choice for the user
    // eslint-disable-next-line no-param-reassign
    input.outputFormats = ['markdown'];

    const validatedInput = validateAndFillInput(input) as UrlToMarkdownInput;
    return validatedInput;
}

function createPlaywrightCrawlerOptions(
    input: Input,
    proxy: ProxyConfiguration | undefined,
    keepAlive = true,
): ContentCrawlerOptions {
    const { maxRequestRetries, desiredConcurrency } = input;

    return {
        type: ContentCrawlerTypes.PLAYWRIGHT,
        crawlerOptions: {
            headless: true,
            keepAlive,
            maxRequestRetries,
            proxyConfiguration: proxy,
            requestHandlerTimeoutSecs: input.requestTimeoutSecs,
            launchContext: {
                launcher: firefox,
            },
            browserPoolOptions: {
                fingerprintOptions: {
                    fingerprintGeneratorOptions: {
                        browsers: [BrowserName.firefox],
                    },
                },
                retireInactiveBrowserAfterSecs: 60,
            },
            autoscaledPoolOptions: {
                desiredConcurrency,
            },
        },
    };
}

function createCheerioCrawlerOptions(
    input: Input,
    proxy: ProxyConfiguration | undefined,
    keepAlive = true,
): ContentCrawlerOptions {
    const { maxRequestRetries, desiredConcurrency } = input;

    return {
        type: ContentCrawlerTypes.CHEERIO,
        crawlerOptions: {
            keepAlive,
            maxRequestRetries,
            proxyConfiguration: proxy,
            requestHandlerTimeoutSecs: input.requestTimeoutSecs,
            autoscaledPoolOptions: {
                desiredConcurrency,
            },
        },
    };
}

/**
 * Validates the input and fills in the default values where necessary.
 * This is a bit ugly, but it's necessary to avoid throwing an error when the query is not provided in standby mode.
 */
function validateAndFillInput(input: Partial<Input>): Input {
    /* eslint-disable no-param-reassign */

    // Request timeout seconds
    input.requestTimeoutSecs = validateRange(
        input.requestTimeoutSecs,
        ragWebBrowserInputSchema.properties.requestTimeoutSecs.minimum,
        ragWebBrowserInputSchema.properties.requestTimeoutSecs.maximum,
        ragWebBrowserInputSchema.properties.requestTimeoutSecs.default,
        'requestTimeoutSecs',
    );

    // Proxy configuration
    if (!input.proxyConfiguration) {
        input.proxyConfiguration = ragWebBrowserInputSchema.properties.proxyConfiguration.default as ProxyConfigurationOptions;
    }

    // Scraping tool
    if (!input.scrapingTool) {
        input.scrapingTool = ragWebBrowserInputSchema.properties.scrapingTool.default as ScrapingTool;
    } else if (input.scrapingTool !== 'browser-playwright' && input.scrapingTool !== 'raw-http') {
        throw new UserInputError('The `scrapingTool` parameter must be either `browser-playwright` or `raw-http`.');
    }

    // Remove elements CSS selector
    if (!input.removeElementsCssSelector) {
        input.removeElementsCssSelector = ragWebBrowserInputSchema.properties.removeElementsCssSelector.default;
    }

    // HTML transformer
    if (!input.htmlTransformer) {
        input.htmlTransformer = ragWebBrowserInputSchema.properties.htmlTransformer.default;
    }

    // Desired concurrency
    input.desiredConcurrency = validateRange(
        input.desiredConcurrency,
        ragWebBrowserInputSchema.properties.desiredConcurrency.minimum,
        ragWebBrowserInputSchema.properties.desiredConcurrency.maximum,
        ragWebBrowserInputSchema.properties.desiredConcurrency.default,
        'desiredConcurrency',
    );

    // Max request retries
    input.maxRequestRetries = validateRange(
        input.maxRequestRetries,
        ragWebBrowserInputSchema.properties.maxRequestRetries.minimum,
        ragWebBrowserInputSchema.properties.maxRequestRetries.maximum,
        ragWebBrowserInputSchema.properties.maxRequestRetries.default,
        'maxRequestRetries',
    );

    // Dynamic content wait seconds
    if (!input.dynamicContentWaitSecs || input.dynamicContentWaitSecs >= input.requestTimeoutSecs) {
        input.dynamicContentWaitSecs = Math.round(input.requestTimeoutSecs / 2);
    }

    // Remove cookie warnings
    if (input.removeCookieWarnings === undefined) {
        input.removeCookieWarnings = ragWebBrowserInputSchema.properties.removeCookieWarnings.default;
    }

    // Debug mode
    if (input.debugMode === undefined) {
        input.debugMode = ragWebBrowserInputSchema.properties.debugMode.default;
    }

    return input as Input;
    /* eslint-enable no-param-reassign */
}

function validateRange(
    value: number | string | undefined,
    min: number,
    max: number,
    defaultValue: number,
    fieldName: string,
) {
    // parse the value as a number to check if it's a valid number
    if (value === undefined) {
        log.info(`The \`${fieldName}\` parameter is not defined. Using the default value ${defaultValue}.`);
        return defaultValue;
    } if (typeof value === 'string') {
        /* eslint-disable-next-line no-param-reassign */
        value = Number(value);
    } if (value < min) {
        log.warning(`The \`${fieldName}\` parameter must be at least ${min}, but was ${fieldName}. Using ${min} instead.`);
        return min;
    } if (value > max) {
        log.warning(`The \`${fieldName}\` parameter must be at most ${max}, but was ${fieldName}. Using ${max} instead.`);
        return max;
    }
    return value;
}
