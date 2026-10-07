import type { ProxyConfigurationOptions } from 'apify';
import { Actor } from 'apify';
import type { CheerioCrawlerOptions } from 'crawlee';
import { BrowserName, log, ProxyConfiguration } from 'crawlee';
import { firefox } from 'playwright';

import ragWebBrowserInputSchema from '../actors/apify_rag-web-browser/.actor/input_schema.json' with { type: 'json' };
import { ContentCrawlerTypes, CRAWLER_MAX_REQUEST_RETRIES, CRAWLER_REQUEST_HANDLER_TIMEOUT_SECS } from './const.js';
import { UserInputError } from './errors.js';
import { blockMediaRequests } from './media.js';
import { getMiniActor } from './mini-actors.js';
import type {
    ContentCrawlerOptions,
    ContentCrawlerUserData,
    ContentScraperSettings,
    Input,
    OutputFormats,
    ProxyOptions,
    RagWebBrowserInput,
    ScrapingTool,
    SERPProxyGroup,
    UrlToMarkdownInput,
} from './types.js';
import { abortRun, isActorStandby } from './utils.js';

const proxyConfigurations = new Map<string, Promise<ProxyConfiguration | undefined>>();

/** Cached because `Actor.createProxyConfiguration` checks proxy access over the network. */
async function getProxyConfiguration(proxyOptions: ProxyOptions) {
    const key = JSON.stringify(proxyOptions);
    let configuration = proxyConfigurations.get(key);

    if (!configuration) {
        configuration = Actor.createProxyConfiguration(proxyOptions);
        proxyConfigurations.set(key, configuration);
        // A rejected configuration must not be served to the next caller.
        configuration.catch(() => proxyConfigurations.delete(key));
    }

    return configuration;
}

const DEFAULT_PROXY_OPTIONS = ragWebBrowserInputSchema.properties.proxyConfiguration.default as ProxyOptions;

/**
 * The configuration every crawler is built with. It resolves the proxy from the request Crawlee is
 * about to send rather than from the input the crawler was built with, so one crawler serves callers
 * that each asked for a different proxy - which is what keeps the Standby crawler set at three
 * however many callers there are.
 *
 * Crawlee calls this per request for the HTTP crawlers and per page for the browser one. The browser
 * one only honours it because its launch context sets `useIncognitoPages`; without that, BrowserPool
 * hands every request whichever browser is free and they all go through the first browser's proxy.
 */
const requestProxyConfiguration = new ProxyConfiguration({
    newUrlFunction: async (sessionId, options) => {
        // Crawlee also resolves a proxy when it launches a browser, with no request in hand.
        const userData = options?.request?.userData as Partial<ContentCrawlerUserData> | undefined;
        const configuration = await getProxyConfiguration(userData?.proxyOptions ?? DEFAULT_PROXY_OPTIONS);

        // Crawlee reads this off the configuration, right after this call, to decide whether to
        // ignore TLS errors. Keep it in step with whichever configuration served the request.
        requestProxyConfiguration.isManInTheMiddle = configuration?.isManInTheMiddle ?? false;

        return (await configuration?.newUrl(sessionId)) ?? null;
    },
});

/**
 * Builds the caller's proxy configuration so that an unusable one is reported now, rather than as a
 * run of failed pages later. The crawlers themselves route through `requestProxyConfiguration`.
 */
async function validateProxyConfiguration(proxyOptions: ProxyOptions, abortOnFailure: boolean) {
    try {
        await getProxyConfiguration(proxyOptions);
    } catch (e) {
        const message = `Cannot use Apify Proxy for scraping the target pages: ${(e as Error).message}`;
        if (!abortOnFailure) throw new UserInputError(message);
        await abortRun(message);
    }
}

/**
 * Processes the input and returns an array of crawler settings. This is ideal for startup of STANDBY mode
 * because it makes it simple to start all crawlers at once.
 */
export async function processStandbyInput(originalInput: Partial<Input>) {
    const { input, searchCrawlerOptions, contentScraperSettings } = await processInputInternal(originalInput, true);

    await validateProxyConfiguration(input.proxyConfiguration, true);
    const contentCrawlerOptions: ContentCrawlerOptions[] = [
        createPlaywrightCrawlerOptions(input),
        createCheerioCrawlerOptions(input),
    ];

    return { input, searchCrawlerOptions, contentCrawlerOptions, contentScraperSettings };
}

/**
 * Processes the input and returns the settings for the crawler.
 */
export async function processInput(originalInput: Partial<Input>) {
    const { input, searchCrawlerOptions, contentScraperSettings } = await processInputInternal(originalInput);

    // In Standby this runs once per request, where a proxy problem must fail that request alone. In
    // Normal mode it is the run's startup, where there is nothing to serve and the run ends.
    await validateProxyConfiguration(input.proxyConfiguration, !isActorStandby());
    const contentCrawlerOptions: ContentCrawlerOptions = input.scrapingTool === 'raw-http'
        ? createCheerioCrawlerOptions(input, false)
        : createPlaywrightCrawlerOptions(input, false);

    return { input, searchCrawlerOptions, contentCrawlerOptions, contentScraperSettings };
}

/**
 * Processes the input and returns the settings for the crawler (adapted from: Website Content Crawler).
 */
async function processInputInternal(
    originalInput: Partial<Input>,
    standbyInit = false,
) {
    const miniActor = getMiniActor();
    let input: Input;
    let searchCrawlerOptions: CheerioCrawlerOptions = {};

    if (miniActor.runsSearch) {
        const processedRagWebBrowserInput = await processRagWebBrowserInput(
            originalInput as Partial<RagWebBrowserInput>, standbyInit);
        input = processedRagWebBrowserInput.validatedRagBrowserInput;
        searchCrawlerOptions = processedRagWebBrowserInput.searchCrawlerOptions;
    } else {
        input = await processUrlToMarkdownInput(originalInput as Partial<UrlToMarkdownInput>);
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
        maxRequestRetries: input.maxRequestRetries,
    };

    return { input, searchCrawlerOptions, contentScraperSettings };
}

async function processRagWebBrowserInput(input: Partial<RagWebBrowserInput>, standbyInit: boolean):
    Promise<{
        validatedRagBrowserInput: RagWebBrowserInput;
        searchCrawlerOptions: CheerioCrawlerOptions
    }> {
    /* eslint-disable no-param-reassign */

    // Note: `query` is intentionally not validated here. It is a per-request property (depending on
    // the mini-actor) rather than a startup/crawler-configuration property, so its presence and validity
    // are checked when the request is actually formed (see `prepareRequest` in search.ts).

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
    } else if (input.outputFormats.some((format) => !['text', 'markdown', 'html', 'links'].includes(format))) {
        throw new UserInputError('The `outputFormats` array may only contain `text`, `markdown`, `html`, or `links`.');
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

    // Request timeout seconds
    input.requestTimeoutSecs = validateRange(
        input.requestTimeoutSecs,
        ragWebBrowserInputSchema.properties.requestTimeoutSecs.minimum,
        ragWebBrowserInputSchema.properties.requestTimeoutSecs.maximum,
        ragWebBrowserInputSchema.properties.requestTimeoutSecs.default,
        'requestTimeoutSecs',
    );

    // Remove cookie warnings
    if (input.removeCookieWarnings === undefined) {
        input.removeCookieWarnings = ragWebBrowserInputSchema.properties.removeCookieWarnings.default;
    }

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

    const searchCrawlerOptions: CheerioCrawlerOptions = {
        keepAlive: standbyInit,
        maxRequestRetries: CRAWLER_MAX_REQUEST_RETRIES,
        proxyConfiguration: requestProxyConfiguration,
        autoscaledPoolOptions: { desiredConcurrency: 1 },
        persistCookiesPerSession: false,
        sessionPoolOptions: { persistenceOptions: { enable: false } },
    };
    const validatedRagBrowserInput = validateAndFillInput(input) as RagWebBrowserInput;
    return {
        validatedRagBrowserInput,
        searchCrawlerOptions,
    };
    /* eslint-enable no-param-reassign */
}

async function processUrlToMarkdownInput(input: Partial<UrlToMarkdownInput>): Promise<UrlToMarkdownInput> {
    // Note: `url` is intentionally not validated or interpreted here. It is a per-request property
    // rather than a startup/crawler-configuration property, so its presence and validity are checked
    // when the request is actually formed (see `prepareRequest` in search.ts).

    // We default to the only supported output format for this mini-actor, no choice for the user
    // eslint-disable-next-line no-param-reassign
    input.outputFormats = ['markdown'];

    // We default to removing cookie warnings. TODO: default for RAG and remove from input schema as well?
    // eslint-disable-next-line no-param-reassign
    input.removeCookieWarnings = true;

    // We default to a specific request timeout. TODO: default for RAG and remove from input schema as well?
    // eslint-disable-next-line no-param-reassign
    input.requestTimeoutSecs = 40;

    // We default to a specific request max retries. TODO: default for RAG and remove from input schema as well?
    // eslint-disable-next-line no-param-reassign
    input.maxRequestRetries = 1;

    // We default to a specific dynamic content wait time. TODO: default for RAG and remove from input schema as well?
    // eslint-disable-next-line no-param-reassign
    input.dynamicContentWaitSecs = 10;

    const validatedInput = validateAndFillInput(input) as UrlToMarkdownInput;
    return validatedInput;
}

function createPlaywrightCrawlerOptions(
    input: Input,
    keepAlive = true,
): ContentCrawlerOptions {
    return {
        type: ContentCrawlerTypes.PLAYWRIGHT,
        crawlerOptions: {
            headless: true,
            keepAlive,
            // The session pool is shared by every caller, so without these two one caller's cookies
            // ride along with another's request. The pool itself stays: Crawlee gates its 401/403/429
            // handling on it, and a blocked page must fail rather than be charged for.
            persistCookiesPerSession: false,
            sessionPoolOptions: { persistenceOptions: { enable: false } },
            maxRequestRetries: CRAWLER_MAX_REQUEST_RETRIES,
            proxyConfiguration: requestProxyConfiguration,
            requestHandlerTimeoutSecs: CRAWLER_REQUEST_HANDLER_TIMEOUT_SECS,
            launchContext: {
                launcher: firefox,
                // Gives each page its own browser context, which is what lets a page carry the proxy
                // its request asked for. Without it BrowserPool reuses whichever browser is free and
                // every request goes through the proxy the first one launched with - silently.
                useIncognitoPages: true,
            },
            preNavigationHooks: [
                async ({ page }) => {
                    await blockMediaRequests(page);
                },
                (_context, gotoOptions) => {
                    // eslint-disable-next-line no-param-reassign
                    gotoOptions.waitUntil = 'domcontentloaded';
                },
            ],
            browserPoolOptions: {
                fingerprintOptions: {
                    fingerprintGeneratorOptions: {
                        browsers: [BrowserName.firefox],
                    },
                },
                retireInactiveBrowserAfterSecs: 60,
            },
            autoscaledPoolOptions: {
                desiredConcurrency: input.desiredConcurrency,
            },
        },
    };
}

function createCheerioCrawlerOptions(
    input: Input,
    keepAlive = true,
): ContentCrawlerOptions {
    return {
        type: ContentCrawlerTypes.CHEERIO,
        crawlerOptions: {
            keepAlive,
            maxRequestRetries: CRAWLER_MAX_REQUEST_RETRIES,
            proxyConfiguration: requestProxyConfiguration,
            requestHandlerTimeoutSecs: CRAWLER_REQUEST_HANDLER_TIMEOUT_SECS,
            persistCookiesPerSession: false,
            sessionPoolOptions: { persistenceOptions: { enable: false } },
            autoscaledPoolOptions: {
                desiredConcurrency: input.desiredConcurrency,
            },
        },
    };
}

/**
 * Validates the input and fills in the default values where necessary.
 */
function validateAndFillInput(input: Partial<Input>): Input {
    /* eslint-disable no-param-reassign */

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
    warnIfLowMemoryForPlaywright(input.scrapingTool, Actor.getEnv().memoryMbytes ?? undefined);

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

    // Debug mode
    if (input.debugMode === undefined) {
        input.debugMode = ragWebBrowserInputSchema.properties.debugMode.default;
    }

    return input as Input;
    /* eslint-enable no-param-reassign */
}

/**
 * Playwright needs meaningfully more memory (and, since Apify ties CPU share to the memory tier, more CPU)
 * than the raw-HTTP path to render a page within the request timeout. Usage data shows runs on the
 * `browser-playwright` tool time out ~35% of the time at the 1024 MB tier, vs. ~1% at 2048 MB and above,
 * so we warn users into bumping memory rather than letting them discover the timeouts themselves.
 */
const LOW_MEMORY_FOR_PLAYWRIGHT_MBYTES = 1024;
const RECOMMENDED_PLAYWRIGHT_MEMORY_MBYTES = 4096;
const MIN_RECOMMENDED_PLAYWRIGHT_MEMORY_MBYTES = 2048;

export function warnIfLowMemoryForPlaywright(scrapingTool: ScrapingTool, memoryMbytes: number | undefined) {
    if (scrapingTool !== 'browser-playwright' || memoryMbytes === undefined) return;
    if (memoryMbytes <= LOW_MEMORY_FOR_PLAYWRIGHT_MBYTES) {
        log.warning(
            `This run has only ${memoryMbytes} MB of memory allocated while using the \`browser-playwright\` `
            + 'scraping tool. Playwright runs are significantly more likely to time out at this memory tier. '
            + `Consider increasing the run's memory to at least ${MIN_RECOMMENDED_PLAYWRIGHT_MEMORY_MBYTES} MB, `
            + `ideally ${RECOMMENDED_PLAYWRIGHT_MEMORY_MBYTES} MB, to reduce the risk of timeouts.`,
        );
    }
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
