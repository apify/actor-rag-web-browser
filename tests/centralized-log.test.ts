import { log } from 'crawlee';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { logStandbyRunSummary } from '../src/centralized-log.js';

// Lines are collected by their `alert` value, so it must not drift.
describe('logStandbyRunSummary', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('logs the summary with the standby-run-summary alert', () => {
        const logInfoSpy = vi.spyOn(log, 'info').mockImplementation(() => undefined);

        logStandbyRunSummary({
            message: 'Serving 0 request(s). Actor responses 1: 1 answered.',
            data: { inFlight: 0, actorResponses: { 200: 1 }, pages: { scraped: 0, failed: 0 }, scrapedPageStatusCodes: {} },
        });

        expect(logInfoSpy).toHaveBeenCalledWith('Run summary: Serving 0 request(s). Actor responses 1: 1 answered.', {
            alert: 'standby-run-summary',
            inFlight: 0,
            actorResponses: { 200: 1 },
            pages: { scraped: 0, failed: 0 },
            scrapedPageStatusCodes: {},
        });
    });
});
