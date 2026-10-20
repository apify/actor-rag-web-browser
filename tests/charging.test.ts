import { log } from 'crawlee';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canAfford, chargeFetch, chargeSearch } from '../src/charging.js';
import { ContentCrawlerTypes } from '../src/const.js';

const mocks = vi.hoisted(() => ({
    charge: vi.fn(),
    getEnv: vi.fn(),
    calculateMaxEventChargeCountWithinLimit: vi.fn(),
}));

vi.mock('apify', () => ({
    Actor: {
        charge: mocks.charge,
        getEnv: mocks.getEnv,
        getChargingManager: () => ({
            calculateMaxEventChargeCountWithinLimit: mocks.calculateMaxEventChargeCountWithinLimit,
        }),
    },
}));

const API_BASE_URL = 'https://api.apify.test/';
const RUN_ID = 'run123';
const TOKEN = 'token123';

const NORMAL_ENV = { apiBaseUrl: API_BASE_URL, actorRunId: RUN_ID, token: TOKEN };
const STANDBY_ENV = { ...NORMAL_ENV, metaOrigin: 'STANDBY' };

const CONTEXT = { idempotencyKey: 'uniqueKey123' };

describe('Pay-per-event charging', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.ACTOR_FULL_NAME = 'apify/rag-web-browser';
        mocks.getEnv.mockReturnValue(NORMAL_ENV);
        // No budget limit, as for a run without `maxTotalChargeUsd`, unless a test is about the budget.
        mocks.calculateMaxEventChargeCountWithinLimit.mockReturnValue(Infinity);
        fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe('in normal mode', () => {
        it('charges the owner of the run through the SDK', async () => {
            await chargeSearch(CONTEXT);

            expect(mocks.charge).toHaveBeenCalledExactlyOnceWith({ eventName: 'search' });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('charges the same fetch event whichever crawler did the work', async () => {
            await chargeFetch(ContentCrawlerTypes.CHEERIO, CONTEXT);
            await chargeFetch(ContentCrawlerTypes.PLAYWRIGHT, CONTEXT);

            expect(mocks.charge).toHaveBeenNthCalledWith(1, { eventName: 'fetch' });
            expect(mocks.charge).toHaveBeenNthCalledWith(2, { eventName: 'fetch' });
        });

        // The crawlers check it before any work goes into a request and right before charging for it.
        it.each([
            { chargeableCount: 1, isCovered: true },
            { chargeableCount: 0, isCovered: false },
        ])('reports whether the run can pay for one more event: $isCovered, with budget for $chargeableCount', ({ chargeableCount, isCovered }) => {
            mocks.calculateMaxEventChargeCountWithinLimit.mockReturnValue(chargeableCount);

            expect(canAfford('fetch')).toBe(isCovered);
            expect(mocks.calculateMaxEventChargeCountWithinLimit).toHaveBeenCalledWith('fetch');
        });
    });

    // A Standby run is ours and shared between callers, so each caller is billed directly.
    describe('in standby mode', () => {
        beforeEach(() => {
            mocks.getEnv.mockReturnValue(STANDBY_ENV);
        });

        it.each([
            { actor: 'apify/rag-web-browser', eventName: 'fetch' },
            { actor: 'apify/url-to-markdown', eventName: 'playwright-result' },
        ])('bills the caller of the request rather than the owner of the run: $actor', async ({ actor, eventName }) => {
            process.env.ACTOR_FULL_NAME = actor;

            await chargeFetch(ContentCrawlerTypes.PLAYWRIGHT, { ...CONTEXT, actorRequestId: 'request123' });

            expect(mocks.charge).not.toHaveBeenCalled();
            expect(fetchMock).toHaveBeenCalledOnce();

            const [url, options] = fetchMock.mock.calls[0];
            expect(url).toBe(`${API_BASE_URL}v2/actor-runs/${RUN_ID}/charge`);
            expect(options.method).toBe('POST');
            expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
            expect(options.headers['Idempotency-Key']).toBe('uniqueKey123');
            expect(options.signal.aborted).toBe(false);
            expect(JSON.parse(options.body)).toEqual({ eventName, count: 1, requestId: 'request123' });
        });

        // The budget is set by the owner of a run, and Standby runs are ours.
        it('does not hold the run to a budget', async () => {
            mocks.calculateMaxEventChargeCountWithinLimit.mockReturnValue(0);

            expect(canAfford('fetch')).toBe(true);
            expect(mocks.calculateMaxEventChargeCountWithinLimit).not.toHaveBeenCalled();
        });

        // A charge that cannot be attributed to a caller would land on us instead.
        it('skips a charge that cannot be attributed to a caller', async () => {
            const warningSpy = vi.spyOn(log, 'warning').mockImplementation(() => undefined);

            await chargeFetch(ContentCrawlerTypes.CHEERIO, CONTEXT);

            expect(mocks.charge).not.toHaveBeenCalled();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(warningSpy).toHaveBeenCalledOnce();
            expect(warningSpy.mock.calls[0][0]).toContain('x-actor-request-id');
        });
    });

    describe('URL to Markdown', () => {
        beforeEach(() => {
            process.env.ACTOR_FULL_NAME = 'apify/url-to-markdown';
        });

        it('prices browser rendering separately from plain HTTP', async () => {
            await chargeFetch(ContentCrawlerTypes.CHEERIO, CONTEXT);
            await chargeFetch(ContentCrawlerTypes.PLAYWRIGHT, CONTEXT);

            expect(mocks.charge).toHaveBeenNthCalledWith(1, { eventName: 'raw-http-result' });
            expect(mocks.charge).toHaveBeenNthCalledWith(2, { eventName: 'playwright-result' });
        });

        it('charges for nothing it does not price, such as a search', async () => {
            await chargeSearch(CONTEXT);

            expect(mocks.charge).not.toHaveBeenCalled();
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    describe('when charging fails', () => {
        it('serves the request and reports why it could not be charged for', async () => {
            process.env.ACTOR_FULL_NAME = 'apify/url-to-markdown';
            mocks.getEnv.mockReturnValue(STANDBY_ENV);
            fetchMock.mockResolvedValue({ ok: false, text: async () => 'requestId is invalid or has expired' });
            const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);

            await expect(chargeFetch(ContentCrawlerTypes.CHEERIO, { ...CONTEXT, actorRequestId: 'request123' })).resolves.toBeUndefined();

            expect(errorSpy).toHaveBeenCalledOnce();
            expect(errorSpy.mock.calls[0][0]).toContain('requestId is invalid or has expired');
        });

        // Without the timeout a hung charge would hold up the request it belongs to.
        it('gives up on a charge that never completes', async () => {
            vi.useFakeTimers();
            try {
                mocks.charge.mockReturnValue(new Promise(() => { /* Never settles. */ }));
                const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);

                const chargePromise = chargeSearch(CONTEXT);
                await vi.advanceTimersByTimeAsync(5_000);

                await expect(chargePromise).resolves.toBeUndefined();
                expect(errorSpy.mock.calls[0][0]).toContain('Timed out');
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
