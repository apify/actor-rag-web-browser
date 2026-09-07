import { log } from 'crawlee';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chargeFetch, chargeSearch } from '../src/charging.js';
import { ContentCrawlerTypes } from '../src/const.js';

const mocks = vi.hoisted(() => ({
    charge: vi.fn(),
    getEnv: vi.fn(),
    getPricingInfo: vi.fn(),
}));

vi.mock('apify', () => ({
    Actor: {
        charge: mocks.charge,
        getEnv: mocks.getEnv,
        getChargingManager: () => ({ getPricingInfo: mocks.getPricingInfo }),
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
        mocks.getPricingInfo.mockReturnValue({ isPayPerEvent: true });
        fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // A build ships before the pricing model is switched over. The SDK ignores a charge off
    // pay-per-event by itself, but the Standby endpoint answers 400, so that call has to be skipped.
    it('does not call the standby charge endpoint off pay-per-event pricing', async () => {
        mocks.getPricingInfo.mockReturnValue({ isPayPerEvent: false });
        mocks.getEnv.mockReturnValue(STANDBY_ENV);

        await chargeSearch({ ...CONTEXT, actorRequestId: 'request123' });
        await chargeFetch(ContentCrawlerTypes.CHEERIO, { ...CONTEXT, actorRequestId: 'request123' });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    // The pricing lookup throws until `Actor.init()` has run, and a failed charge must never take a
    // request down with it.
    it('serves the request even when the pricing of the Actor cannot be read', async () => {
        mocks.getPricingInfo.mockImplementation(() => {
            throw new Error('ChargingManager is not initialized');
        });
        mocks.getEnv.mockReturnValue(STANDBY_ENV);

        const context = { ...CONTEXT, actorRequestId: 'request123' };
        await expect(chargeFetch(ContentCrawlerTypes.CHEERIO, context)).resolves.toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
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
    });

    describe('in standby mode', () => {
        beforeEach(() => {
            mocks.getEnv.mockReturnValue(STANDBY_ENV);
        });

        it('bills the caller of the request rather than the owner of the run', async () => {
            await chargeFetch(ContentCrawlerTypes.PLAYWRIGHT, { ...CONTEXT, actorRequestId: 'request123' });

            expect(mocks.charge).not.toHaveBeenCalled();
            expect(fetchMock).toHaveBeenCalledOnce();

            const [url, options] = fetchMock.mock.calls[0];
            expect(url).toBe(`${API_BASE_URL}v2/actor-runs/${RUN_ID}/charge`);
            expect(options.method).toBe('POST');
            expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
            expect(options.signal).toBeInstanceOf(AbortSignal);
            expect(JSON.parse(options.body)).toEqual({ eventName: 'fetch', count: 1, requestId: 'request123' });
        });

        // Retrying a request that was already charged for must not bill the caller twice, which the
        // platform can only tell from the key.
        it('identifies the charge by the request it belongs to', async () => {
            await chargeFetch(ContentCrawlerTypes.CHEERIO, { actorRequestId: 'request123', idempotencyKey: 'uniqueKey123' });
            await chargeFetch(ContentCrawlerTypes.CHEERIO, { actorRequestId: 'request123', idempotencyKey: 'uniqueKey123' });

            const keys = fetchMock.mock.calls.map((call) => call[1].headers['Idempotency-Key']);
            expect(keys).toEqual(['uniqueKey123', 'uniqueKey123']);
        });

        // Single-tenant Standby gives every caller a run of their own, so its owner is the caller.
        it('falls back to the owner of the run when the caller cannot be identified', async () => {
            await chargeFetch(ContentCrawlerTypes.CHEERIO, CONTEXT);

            expect(fetchMock).not.toHaveBeenCalled();
            expect(mocks.charge).toHaveBeenCalledExactlyOnceWith({ eventName: 'fetch' });
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

        // Its Standby runs are shared between callers, so a charge that cannot be attributed to one of
        // them would land on us instead.
        it('skips a standby charge that cannot be attributed to a caller', async () => {
            mocks.getEnv.mockReturnValue(STANDBY_ENV);
            const warningSpy = vi.spyOn(log, 'warning').mockImplementation(() => undefined);

            await chargeFetch(ContentCrawlerTypes.CHEERIO, CONTEXT);

            expect(mocks.charge).not.toHaveBeenCalled();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(warningSpy).toHaveBeenCalledOnce();
            expect(warningSpy.mock.calls[0][0]).toContain('x-actor-request-id');
        });
    });

    describe('when charging fails', () => {
        it('serves the request and reports why it could not be charged for', async () => {
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
