import { Actor } from 'apify';
import { log } from 'crawlee';

import type { ContentCrawlerTypes } from './const.js';
import { getMiniActor } from './mini-actors.js';
import { isActorStandby } from './utils.js';

const CHARGE_TIMEOUT_MILLIS = 5_000;

export interface ChargeContext {
    /** ID of the live Standby request whose caller is to be billed, when there is one. */
    actorRequestId?: string;
    /**
     * Identifies the charge to the platform, which ignores a key it has already seen. Crawlee retries a
     * request handler that fails after its charge went through, so this has to identify the request
     * being charged for rather than the attempt - `Request.uniqueKey` does exactly that.
     */
    idempotencyKey: string;
}

/** Whether the current run is billed per event. */
function isPayPerEvent(): boolean {
    try {
        return Actor.getChargingManager().getPricingInfo().isPayPerEvent;
    } catch {
        // `getPricingInfo` throws until `Actor.init()` has initialized the charging manager.
        return false;
    }
}

/** Charges the owner of the run. Unlike the endpoint call below, the SDK call has no deadline. */
async function chargeRunOwner(eventName: string): Promise<void> {
    await withTimeout(Actor.charge({ eventName }), CHARGE_TIMEOUT_MILLIS);
}

/**
 * Charges the caller of a live STANDBY request by POSTing to the platform charge endpoint with the ID
 * of that request.
 *
 * This exists for multi-tenant Standby, where one run serves many callers and the request ID is the
 * only thing telling the platform which of them to bill. Single-tenant Standby takes the same path
 * whenever the header is there, and lands on the same account either way, because the caller owns the
 * run.
 *
 * The request ID is only valid while its HTTP request is in flight, so this must be awaited before
 * the response to that request is sent.
 */
async function chargeStandbyCaller(eventName: string, actorRequestId: string, idempotencyKey: string): Promise<void> {
    // `Actor.charge` quietly ignores a charge off pay-per-event, but this endpoint answers `400
    // cannot-charge-non-pay-per-event-actor`. Without this, a build shipped ahead of the pricing switch
    // would log a charging error on every Standby request until the switch lands.
    if (!isPayPerEvent()) return;

    const { apiBaseUrl, actorRunId, token } = Actor.getEnv();
    if (!apiBaseUrl || !actorRunId || !token) {
        throw new Error('Missing apiBaseUrl/actorRunId/token in Actor.getEnv().');
    }

    const response = await fetch(`${apiBaseUrl}v2/actor-runs/${actorRunId}/charge`, {
        method: 'POST',
        // Without this the request outlives the timeout below, holding its connection open.
        signal: AbortSignal.timeout(CHARGE_TIMEOUT_MILLIS),
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ eventName, count: 1, requestId: actorRequestId }),
    });

    if (!response.ok) {
        throw new Error(await response.text());
    }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMillis: number): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`Timed out after ${timeoutMillis} ms`)), timeoutMillis);
            }),
        ]);
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Charges a single pay-per-event event, unless the event is not priced or the Actor is not on
 * pay-per-event pricing. Never throws - a request is served even when we fail to charge for it.
 */
async function charge(eventName: string | undefined, { actorRequestId, idempotencyKey }: ChargeContext): Promise<void> {
    if (!eventName) return;

    // Reached only when a request bypassed the Standby controller, which sets the header on everything
    // it proxies. Charging the run owner instead is right for single-tenant Standby, where the run
    // belongs to the caller, but in multi-tenant the run is ours and the charge would land on us.
    if (isActorStandby() && !actorRequestId && getMiniActor().standbyTenancy === 'MULTI_TENANT') {
        log.warning(`Skipping the standby charge for the \`${eventName}\` event: the x-actor-request-id header is missing, so the caller cannot be identified.`);
        return;
    }

    try {
        await (isActorStandby() && actorRequestId
            ? chargeStandbyCaller(eventName, actorRequestId, idempotencyKey)
            : chargeRunOwner(eventName));
    } catch (err) {
        log.error(`Failed to charge for the \`${eventName}\` event: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * Charges for one Google Search query, once the search has actually returned results. Callers are
 * responsible for charging a query only once, however many result pages it spans.
 */
export async function chargeSearch(context: ChargeContext): Promise<void> {
    await charge(getMiniActor().chargeEvents.search, context);
}

/**
 * Charges for one web page handled by the given crawler. Pages that hold no extractable content, such
 * as media files, are charged too; only a page that fails to load is free.
 */
export async function chargeFetch(crawlerType: ContentCrawlerTypes, context: ChargeContext): Promise<void> {
    await charge(getMiniActor().chargeEvents.fetch?.[crawlerType], context);
}
