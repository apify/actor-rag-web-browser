import { Actor } from 'apify';
import { log } from 'crawlee';

import type { ContentCrawlerTypes } from './const.js';
import { getMiniActor } from './mini-actors.js';
import { isActorStandby, randomId } from './utils.js';

/** How long to wait for a charge to go through before giving up on it. */
const CHARGE_TIMEOUT_MILLIS = 5_000;

let standbyRunOwnerWarningPrinted = false;

/**
 * Whether the current run is billed per event.
 *
 * Charging is a no-op otherwise, which is what lets a single build run under both the old
 * compute-unit pricing and the new pay-per-event pricing while the 14-day price-change notice is
 * pending (see https://github.com/apify/actor-rag-web-browser/issues/146).
 */
function isPayPerEvent(): boolean {
    try {
        return Actor.getChargingManager().getPricingInfo().isPayPerEvent;
    } catch {
        // `getPricingInfo` throws until `Actor.init()` has initialized the charging manager.
        return false;
    }
}

/**
 * Charges the owner of the current run through the Actor SDK.
 *
 * In STANDBY mode this is only correct for single-tenant Actors, where the platform starts a separate
 * run per calling user; for multi-tenant Actors it would bill us instead of the caller.
 */
async function chargeRunOwner(eventName: string): Promise<void> {
    await Actor.charge({ eventName });
}

/**
 * Charges the caller of a live STANDBY request by POSTing to the platform charge endpoint with the ID
 * of that request, so that the caller is billed rather than the owner of the (possibly shared) run.
 *
 * The request ID is only valid while its HTTP request is in flight, so this must be awaited before
 * the response to that request is sent.
 */
async function chargeStandbyCaller(eventName: string, actorRequestId: string): Promise<void> {
    const { apiBaseUrl, actorRunId, token } = Actor.getEnv();
    if (!apiBaseUrl || !actorRunId || !token) {
        throw new Error('Missing apiBaseUrl/actorRunId/token in Actor.getEnv().');
    }

    const response = await fetch(`${apiBaseUrl}v2/actor-runs/${actorRunId}/charge`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': randomId(),
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
async function charge(eventName: string | undefined, actorRequestId?: string): Promise<void> {
    if (!eventName || !isPayPerEvent()) return;

    const canChargeStandbyCaller = isActorStandby() && actorRequestId !== undefined;
    if (isActorStandby() && !canChargeStandbyCaller && !standbyRunOwnerWarningPrinted) {
        log.warning('Charging the owner of this Standby run instead of the caller: the x-actor-request-id'
            + ' header is missing, so the caller cannot be identified. That is correct only as long as the'
            + ' Actor stays in the single-tenant Standby mode, where every caller gets a run of their own.');
        standbyRunOwnerWarningPrinted = true;
    }

    try {
        await withTimeout(
            canChargeStandbyCaller
                ? chargeStandbyCaller(eventName, actorRequestId!)
                : chargeRunOwner(eventName),
            CHARGE_TIMEOUT_MILLIS,
        );
    } catch (err) {
        log.error(`Failed to charge for the \`${eventName}\` event: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * Charges for starting the Actor, once per run.
 *
 * A STANDBY run is started by the platform rather than by a user and then serves many requests, so
 * only NORMAL runs are charged. The guard lives here rather than at the call site so that moving the
 * call cannot silently change what users pay.
 */
export async function chargeActorStart(): Promise<void> {
    if (isActorStandby()) return;

    await charge(getMiniActor().chargeEvents.actorStart);
}

/**
 * Charges for one Google Search query. Charged when the query is submitted, so that a query is paid
 * for once regardless of how many result pages and retries answering it takes.
 */
export async function chargeSearch(actorRequestId?: string): Promise<void> {
    await charge(getMiniActor().chargeEvents.search, actorRequestId);
}

/** Charges for one web page whose content the given crawler has extracted. */
export async function chargeFetch(crawlerType: ContentCrawlerTypes, actorRequestId?: string): Promise<void> {
    await charge(getMiniActor().chargeEvents.fetch?.[crawlerType], actorRequestId);
}
