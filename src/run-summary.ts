import { logStandbyRunSummary } from './centralized-log.js';
import { ContentCrawlerStatus } from './const.js';
import { responseData } from './responses.js';
import type { Output } from './types.js';

const SUMMARY_INTERVAL_MILLIS = 60_000;

/**
 * What a Standby run reports about itself. Two statuses are kept apart: the one the Actor sent the caller, and the one
 * each site returned for its page. The Actor answers `200` once every page has finished, even if every page failed.
 */
export type RunSummary = {
    /** Every response the server sends. */
    recordResponse: (statusCode: number) => void;
    /** The pages of a response sent with `200`. */
    recordPages: (results: Output[]) => void;
    describe: (inFlightCount: number) => { message: string; data: RunSummaryData };
};

/** A scraped page with no status code, which happens when the browser gets no response for its navigation. */
type UnknownStatusCode = 'unknown';

type RunSummaryData = {
    inFlight: number;
    actorResponses: Record<string, number>;
    pages: { scraped: number; failed: number };
    scrapedPageStatusCodes: Record<string, number>;
};

/** Codes with no label are summed into `other`. A timed-out response with no page finished is a `500` too. */
const ACTOR_RESPONSE_LABELS: Record<number, string> = {
    200: 'answered',
    400: 'rejected',
    404: 'rejected',
    500: 'failed',
    503: 'turned away',
};

export function createRunSummary(): RunSummary {
    const actorResponses = new Map<number, number>();
    // Only scraped pages: a failed page's status code is `500` when it did not load, whatever the site returned.
    const scrapedPageStatusCodes = new Map<number | UnknownStatusCode, number>();
    let scrapedPageCount = 0;
    let failedPageCount = 0;

    return {
        recordResponse: (statusCode) => increment(actorResponses, statusCode),
        recordPages: (results) => {
            for (const { crawl } of results) {
                if (crawl.requestStatus === ContentCrawlerStatus.HANDLED) {
                    scrapedPageCount++;
                    increment(scrapedPageStatusCodes, crawl.httpStatusCode ?? 'unknown');
                } else {
                    failedPageCount++;
                }
            }
        },
        describe: (inFlightCount) => {
            const data = {
                inFlight: inFlightCount,
                actorResponses: Object.fromEntries(actorResponses),
                pages: { scraped: scrapedPageCount, failed: failedPageCount },
                scrapedPageStatusCodes: Object.fromEntries(scrapedPageStatusCodes),
            };
            return { message: describeMessage(data), data };
        },
    };
}

/** Logs the summary once a minute, so the run's log shows how its requests went. */
export function startPeriodicSummaryLog(summary: RunSummary) {
    setInterval(() => {
        logStandbyRunSummary(summary.describe(responseData.size));
    }, SUMMARY_INTERVAL_MILLIS).unref();
}

function describeMessage(data: RunSummaryData) {
    const serving = `Serving ${data.inFlight} request(s).`;

    let responseCount = 0;
    const countByLabel = new Map<string, number>();
    for (const [statusCode, count] of Object.entries(data.actorResponses)) {
        responseCount += count;
        increment(countByLabel, ACTOR_RESPONSE_LABELS[Number(statusCode)] ?? 'other', count);
    }
    if (responseCount === 0) {
        return `${serving} Nothing answered yet.`;
    }

    // The most frequent outcome first, so a run that is going wrong says so first.
    const segments = [...countByLabel]
        .sort(([, left], [, right]) => right - left)
        .map(([label, count]) => `${count} ${label}`);

    return `${serving} Actor responses ${responseCount}: ${segments.join(', ')}.${describePages(data)}`;
}

function describePages({ pages, scrapedPageStatusCodes }: RunSummaryData) {
    const pageCount = pages.scraped + pages.failed;
    if (pageCount === 0) {
        return '';
    }

    let scraped = `${pages.scraped} scraped`;
    if (pages.scraped > 0) {
        const statusCodes = Object.entries(scrapedPageStatusCodes).map(([statusCode, count]) => `${statusCode}: ${count}`);
        scraped += ` (site status ${statusCodes.join(', ')})`;
    }

    return ` Pages in answered responses ${pageCount}: ${scraped}, ${pages.failed} failed.`;
}

function increment<Key>(counts: Map<Key, number>, key: Key, by = 1) {
    counts.set(key, (counts.get(key) ?? 0) + by);
}
