import { log } from 'crawlee';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContentCrawlerStatus } from '../src/const.js';
import { createRunSummary, startPeriodicSummaryLog } from '../src/run-summary.js';
import type { Output } from '../src/types.js';

function page(requestStatus: ContentCrawlerStatus, httpStatusCode?: number) {
    return { crawl: { requestStatus, httpStatusCode } } as Output;
}

describe('createRunSummary', () => {
    it('says nothing was answered before the first response', () => {
        const summary = createRunSummary();

        expect(summary.describe(1).message).toBe('Serving 1 request(s). Nothing answered yet.');
    });

    it('names responses by what their status code means to the caller', () => {
        const summary = createRunSummary();
        summary.recordResponse(200);
        summary.recordResponse(400);
        summary.recordResponse(500);
        summary.recordResponse(503);

        expect(summary.describe(2).message).toBe(
            'Serving 2 request(s). Actor responses 4: 1 answered, 1 rejected, 1 failed, 1 turned away.',
        );
    });

    it('lists the most frequent outcome first', () => {
        const summary = createRunSummary();
        summary.recordResponse(200);
        summary.recordResponse(500);
        summary.recordResponse(500);

        expect(summary.describe(0).message).toBe('Serving 0 request(s). Actor responses 3: 2 failed, 1 answered.');
    });

    it('counts 400 and 404 together as rejected', () => {
        const summary = createRunSummary();
        summary.recordResponse(400);
        summary.recordResponse(404);

        expect(summary.describe(0).message).toBe('Serving 0 request(s). Actor responses 2: 2 rejected.');
    });

    it('counts a status code with no label as other', () => {
        const summary = createRunSummary();
        summary.recordResponse(418);

        expect(summary.describe(0).message).toBe('Serving 0 request(s). Actor responses 1: 1 other.');
    });

    it('shows the site status codes of the scraped pages', () => {
        const summary = createRunSummary();
        summary.recordResponse(200);
        summary.recordPages([page(ContentCrawlerStatus.HANDLED, 200), page(ContentCrawlerStatus.HANDLED, 404)]);

        expect(summary.describe(0).message).toBe(
            'Serving 0 request(s). Actor responses 1: 1 answered. '
            + 'Pages in answered responses 2: 2 scraped (site status 200: 1, 404: 1), 0 failed.',
        );
    });

    it('shows no site status codes when every page failed', () => {
        const summary = createRunSummary();
        summary.recordResponse(200);
        summary.recordPages([page(ContentCrawlerStatus.FAILED, 500)]);

        expect(summary.describe(0).message).toBe(
            'Serving 0 request(s). Actor responses 1: 1 answered. Pages in answered responses 1: 0 scraped, 1 failed.',
        );
    });

    it('counts a scraped page with no status code as unknown', () => {
        const summary = createRunSummary();
        summary.recordPages([page(ContentCrawlerStatus.HANDLED)]);

        expect(summary.describe(0).data.scrapedPageStatusCodes).toEqual({ unknown: 1 });
    });

    it('keeps the Actor response and site status codes apart in the data', () => {
        const summary = createRunSummary();
        summary.recordResponse(200);
        summary.recordResponse(400);
        summary.recordResponse(404);
        summary.recordPages([page(ContentCrawlerStatus.HANDLED, 404), page(ContentCrawlerStatus.FAILED, 500)]);

        expect(summary.describe(3).data).toEqual({
            inFlight: 3,
            actorResponses: { 200: 1, 400: 1, 404: 1 },
            pages: { scraped: 1, failed: 1 },
            scrapedPageStatusCodes: { 404: 1 },
        });
    });
});

describe('startPeriodicSummaryLog', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('logs the summary once a minute', () => {
        // Given
        vi.useFakeTimers();
        const logInfoSpy = vi.spyOn(log, 'info').mockImplementation(() => undefined);
        const summary = createRunSummary();
        summary.recordResponse(200);

        // When
        startPeriodicSummaryLog(summary);
        vi.advanceTimersByTime(60_000);

        // Then
        expect(logInfoSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            alert: 'standby-run-summary',
            actorResponses: { 200: 1 },
        }));
    });
});
