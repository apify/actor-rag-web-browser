import { log } from 'crawlee';

import ragWebBrowserInputSchema from '../actors/apify_rag-web-browser/.actor/input_schema.json' with { type: 'json' };
import urlToMarkdownInputSchema from '../actors/apify_url-to-markdown/.actor/input_schema.json' with { type: 'json' };
import { ContentCrawlerTypes, Routes } from './const.js';

export type InputSchema = typeof ragWebBrowserInputSchema | typeof urlToMarkdownInputSchema;

/**
 * Names of the pay-per-event events a mini-actor charges for. They must match the events configured in
 * the Actor's monetization settings in Apify Console exactly, or the platform rejects the charge. An
 * event that is not listed here is never charged.
 *
 * Starting the Actor is deliberately absent: that is the platform's own `apify-actor-start`, which it
 * charges by itself and which an Actor must not charge for.
 */
export interface ChargeEvents {
    /** Charged once per search query, in both modes, however many result pages it takes. */
    search?: string;
    /**
     * Charged once per fetched page, in both modes. Keyed by the crawler that handled it so that
     * browser rendering can be priced above plain HTTP - RAG Web Browser prices both the same.
     */
    fetch?: Record<ContentCrawlerTypes, string>;
}

export interface MiniActor {
    name: string;
    runsSearch: boolean;
    inputSchema: InputSchema;
    mcpServerName: string;
    route: Routes;
    helpRoute: string;
    chargeEvents: ChargeEvents;
    /**
     * Mirrors the Actor's `actorStandby.tenancy` setting on the platform, which decides who owns a
     * Standby run and so who a charge without a request ID lands on. Update it when moving the Actor
     * to multi-tenant Standby.
     *
     * Hardcoded because the platform exposes tenancy only through `GET /v2/acts/{actorId}` - not as an
     * environment variable, not in `actor.json`, and not in apify-client's typed `ActorStandby`.
     */
    standbyTenancy: 'SINGLE_TENANT' | 'MULTI_TENANT';
}

const MINI_ACTORS: Record<string, MiniActor> = {
    'rag-web-browser': {
        name: 'rag-web-browser',
        runsSearch: true,
        inputSchema: ragWebBrowserInputSchema,
        mcpServerName: 'mcp-server-rag-web-browser',
        route: Routes.SEARCH,
        helpRoute: '/search?query=hello+world',
        standbyTenancy: 'SINGLE_TENANT',
        chargeEvents: {
            search: 'search',
            fetch: {
                [ContentCrawlerTypes.CHEERIO]: 'fetch',
                [ContentCrawlerTypes.PLAYWRIGHT]: 'fetch',
            },
        },
    },
    'url-to-markdown': {
        name: 'url-to-markdown',
        runsSearch: false,
        inputSchema: urlToMarkdownInputSchema,
        mcpServerName: 'mcp-server-url-to-markdown',
        route: Routes.FETCH,
        helpRoute: '/fetch?url=https://example.com',
        standbyTenancy: 'MULTI_TENANT',
        chargeEvents: {
            fetch: {
                [ContentCrawlerTypes.CHEERIO]: 'raw-http-result',
                [ContentCrawlerTypes.PLAYWRIGHT]: 'playwright-result',
            },
        },
    },
};

export function getMiniActor(): MiniActor {
    const actorKey = process.env.ACTOR_FULL_NAME?.split('/')[1];
    const miniActor = actorKey ? MINI_ACTORS[actorKey] : undefined;

    if (!miniActor) {
        log.warning(`The ACTOR_FULL_NAME ${process.env.ACTOR_FULL_NAME} environment variable is not set to a known value. Please report to the developers.`);
        throw new Error('Unknown mini-actor');
    }

    return miniActor;
}
