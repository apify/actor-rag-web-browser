import { Actor, ApifyClient } from 'apify';

import { Routes } from './const.js';
import { getMiniActor } from './mini-actors.js';

let dataset: ReturnType<ApifyClient['dataset']> | null = null;
let userId: string | null = null;
let enabled = false;

// For these routes, the single allow-listed key alone doesn't warrant logging (see logRequest).
const REQUIRED_QUERY_PARAM: Record<string, string> = {
    [Routes.SEARCH]: 'query',
    [Routes.FETCH]: 'url',
};

/**
 * Initialize request logging (no-op if REQUEST_LOG_DATASET_ID is not set). Call once at startup.
 */
export async function initRequestLogger(): Promise<void> {
    const datasetId = process.env.REQUEST_LOG_DATASET_ID;
    if (!datasetId) return;

    try {
        userId = Actor.getEnv().userId;
        const client = new ApifyClient({ token: process.env.REQUEST_LOG_DATASET_TOKEN });
        dataset = client.dataset(datasetId);
        enabled = true;
    } catch {
        // Silently disable logging on any failure (invalid dataset id, etc.)
        dataset = null;
        enabled = false;
    }
}

/**
 * Fire-and-forget logging of an incoming request to the request-log dataset. Never throws, never blocks.
 * @param pathname the request path (e.g. req.path), also used to look up the route's required query param
 * @param query the raw req.query object
 */
export function logRequest(pathname: string, query: Record<string, unknown>): void {
    if (!enabled || !dataset) return;

    try {
        const requiredParamKey = REQUIRED_QUERY_PARAM[pathname];
        let loggedQuery: Record<string, string> = {};

        if (requiredParamKey !== undefined) {
            const keys = Object.keys(query).filter((key) => key !== requiredParamKey);
            if (keys.length === 0) return;
            loggedQuery = { ...(query as Record<string, string>) };
            delete loggedQuery[requiredParamKey];
        }

        // Never persist the token query param (used for standby-mode auth) into the logged item.
        delete loggedQuery.token;

        const item = {
            miniActor: getMiniActor().name,
            pathname,
            timestamp: new Date().toISOString(),
            userId,
            query: loggedQuery,
        };

        dataset.pushItems(item).catch(() => { /**/ });
    } catch { /**/ }
}
