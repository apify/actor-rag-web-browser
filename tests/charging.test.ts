import { log } from 'crawlee';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/** Reloads the module so that its "warn only once" state does not leak between test cases. */
async function loadCharging() {
    vi.resetModules();
    return import('../src/charging.js');
}

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

    describe('when the Actor is not on pay-per-event pricing', () => {
        // The Actor must keep working unchanged until the pricing model switch takes effect.
        beforeEach(() => {
            mocks.getPricingInfo.mockReturnValue({ isPayPerEvent: false });
        });

        it('charges for nothing in normal mode', async () => {
            const { chargeActorStart, chargeFetch, chargeSearch } = await loadCharging();

            await chargeActorStart();
            await chargeSearch();
            await chargeFetch(ContentCrawlerTypes.CHEERIO);

            expect(mocks.charge).not.toHaveBeenCalled();
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('charges for nothing in standby mode', async () => {
            mocks.getEnv.mockReturnValue(STANDBY_ENV);
            const { chargeFetch, chargeSearch } = await loadCharging();

            await chargeSearch('request123');
            await chargeFetch(ContentCrawlerTypes.PLAYWRIGHT, 'request123');

            expect(mocks.charge).not.toHaveBeenCalled();
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    it('charges for nothing before the charging manager is initialized', async () => {
        mocks.getPricingInfo.mockImplementation(() => {
            throw new Error('ChargingManager is not initialized');
        });
        const { chargeActorStart, chargeFetch, chargeSearch } = await loadCharging();

        await expect(chargeActorStart()).resolves.toBeUndefined();
        await chargeSearch();
        await chargeFetch(ContentCrawlerTypes.CHEERIO);

        expect(mocks.charge).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    describe('RAG Web Browser in normal mode', () => {
        it('charges the run owner for starting the Actor', async () => {
            const { chargeActorStart } = await loadCharging();

            await chargeActorStart();

            expect(mocks.charge).toHaveBeenCalledExactlyOnceWith({ eventName: 'actor-start' });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('charges the run owner for a search', async () => {
            const { chargeSearch } = await loadCharging();

            await chargeSearch();

            expect(mocks.charge).toHaveBeenCalledExactlyOnceWith({ eventName: 'search' });
        });

        it('charges the same fetch event for both content crawlers', async () => {
            const { chargeFetch } = await loadCharging();

            await chargeFetch(ContentCrawlerTypes.CHEERIO);
            await chargeFetch(ContentCrawlerTypes.PLAYWRIGHT);

            expect(mocks.charge).toHaveBeenCalledTimes(2);
            expect(mocks.charge).toHaveBeenNthCalledWith(1, { eventName: 'fetch' });
            expect(mocks.charge).toHaveBeenNthCalledWith(2, { eventName: 'fetch' });
        });
    });

    describe('RAG Web Browser in standby mode', () => {
        beforeEach(() => {
            mocks.getEnv.mockReturnValue(STANDBY_ENV);
        });

        it('does not charge for starting the Actor', async () => {
            const { chargeActorStart } = await loadCharging();

            await chargeActorStart();

            expect(mocks.charge).not.toHaveBeenCalled();
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('charges the caller of the request that triggered the fetch', async () => {
            const { chargeFetch } = await loadCharging();

            await chargeFetch(ContentCrawlerTypes.PLAYWRIGHT, 'request123');

            expect(mocks.charge).not.toHaveBeenCalled();
            expect(fetchMock).toHaveBeenCalledOnce();

            const [url, options] = fetchMock.mock.calls[0];
            expect(url).toBe(`${API_BASE_URL}v2/actor-runs/${RUN_ID}/charge`);
            expect(options.method).toBe('POST');
            expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
            expect(options.headers['Idempotency-Key']).toBeTruthy();
            expect(JSON.parse(options.body)).toEqual({ eventName: 'fetch', count: 1, requestId: 'request123' });
        });

        it('charges the caller of the request that triggered the search', async () => {
            const { chargeSearch } = await loadCharging();

            await chargeSearch('request123');

            const [, options] = fetchMock.mock.calls[0];
            expect(JSON.parse(options.body)).toEqual({ eventName: 'search', count: 1, requestId: 'request123' });
        });

        it('uses a fresh idempotency key per charge', async () => {
            const { chargeFetch } = await loadCharging();

            await chargeFetch(ContentCrawlerTypes.CHEERIO, 'request123');
            await chargeFetch(ContentCrawlerTypes.CHEERIO, 'request123');

            const [firstKey, secondKey] = fetchMock.mock.calls.map((call) => call[1].headers['Idempotency-Key']);
            expect(firstKey).not.toBe(secondKey);
        });

        // Single-tenant Standby gives every caller a run of their own, so the owner of the run is the
        // caller and charging them is still correct.
        it('charges the run owner when the request ID is missing', async () => {
            const { chargeFetch } = await loadCharging();

            await chargeFetch(ContentCrawlerTypes.CHEERIO);

            expect(fetchMock).not.toHaveBeenCalled();
            expect(mocks.charge).toHaveBeenCalledExactlyOnceWith({ eventName: 'fetch' });
        });
    });

    describe('URL to Markdown', () => {
        beforeEach(() => {
            process.env.ACTOR_FULL_NAME = 'apify/url-to-markdown';
        });

        it('prices browser rendering separately from plain HTTP', async () => {
            const { chargeFetch } = await loadCharging();

            await chargeFetch(ContentCrawlerTypes.CHEERIO);
            await chargeFetch(ContentCrawlerTypes.PLAYWRIGHT);

            expect(mocks.charge).toHaveBeenNthCalledWith(1, { eventName: 'raw-http-result' });
            expect(mocks.charge).toHaveBeenNthCalledWith(2, { eventName: 'playwright-result' });
        });

        // Its Standby runs are shared between callers, so a charge that cannot be attributed to one of
        // them would land on us and eat into the shared run's charge limit.
        it('skips a standby charge that cannot be attributed to a caller', async () => {
            mocks.getEnv.mockReturnValue(STANDBY_ENV);
            const warningSpy = vi.spyOn(log, 'warning').mockImplementation(() => undefined);
            const { chargeFetch } = await loadCharging();

            await chargeFetch(ContentCrawlerTypes.CHEERIO);

            expect(mocks.charge).not.toHaveBeenCalled();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(warningSpy).toHaveBeenCalledOnce();
            expect(warningSpy.mock.calls[0][0]).toContain('x-actor-request-id');
        });

        it('charges for neither the Actor start nor searches, which it does not price', async () => {
            const { chargeActorStart, chargeSearch } = await loadCharging();

            await chargeActorStart();
            await chargeSearch();

            expect(mocks.charge).not.toHaveBeenCalled();
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    describe('failure handling', () => {
        it('swallows a rejected standby charge', async () => {
            mocks.getEnv.mockReturnValue(STANDBY_ENV);
            fetchMock.mockResolvedValue({ ok: false, text: async () => 'requestId is invalid or has expired' });
            const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
            const { chargeFetch } = await loadCharging();

            await expect(chargeFetch(ContentCrawlerTypes.CHEERIO, 'request123')).resolves.toBeUndefined();

            expect(errorSpy).toHaveBeenCalledOnce();
            expect(errorSpy.mock.calls[0][0]).toContain('requestId is invalid or has expired');
        });

        it('swallows an incomplete standby environment', async () => {
            mocks.getEnv.mockReturnValue({ metaOrigin: 'STANDBY' });
            const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
            const { chargeFetch } = await loadCharging();

            await expect(chargeFetch(ContentCrawlerTypes.CHEERIO, 'request123')).resolves.toBeUndefined();

            expect(fetchMock).not.toHaveBeenCalled();
            expect(errorSpy).toHaveBeenCalledOnce();
        });

        it('swallows a throwing charge in normal mode', async () => {
            mocks.charge.mockRejectedValue(new Error('Actor run not found'));
            const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
            const { chargeActorStart } = await loadCharging();

            await expect(chargeActorStart()).resolves.toBeUndefined();

            expect(errorSpy).toHaveBeenCalledOnce();
            expect(errorSpy.mock.calls[0][0]).toContain('Actor run not found');
        });

        it('gives up on a charge that never completes', async () => {
            vi.useFakeTimers();
            try {
                mocks.charge.mockReturnValue(new Promise(() => { /* Never settles. */ }));
                const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
                const { chargeActorStart } = await loadCharging();

                const chargePromise = chargeActorStart();
                await vi.advanceTimersByTimeAsync(5_000);
                await expect(chargePromise).resolves.toBeUndefined();

                expect(errorSpy).toHaveBeenCalledOnce();
                expect(errorSpy.mock.calls[0][0]).toContain('Timed out');
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
