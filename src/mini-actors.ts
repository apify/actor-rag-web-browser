import { log } from 'crawlee';

import ragWebBrowserInputSchema from '../actors/apify_rag-web-browser/.actor/input_schema.json' with { type: 'json' };
import urlToMarkdownInputSchema from '../actors/apify_url-to-markdown/.actor/input_schema.json' with { type: 'json' };
import { Routes } from './const.js';

export type InputSchema = typeof ragWebBrowserInputSchema | typeof urlToMarkdownInputSchema;

export interface MiniActor {
    name: string;
    runsSearch: boolean;
    inputSchema: InputSchema;
    mcpServerName: string;
    route: Routes;
    helpRoute: string;
}

const MINI_ACTORS: Record<string, MiniActor> = {
    'rag-web-browser': {
        name: 'apify_rag-web-browser',
        runsSearch: true,
        inputSchema: ragWebBrowserInputSchema,
        mcpServerName: 'mcp-server-rag-web-browser',
        route: Routes.SEARCH,
        helpRoute: '/search?query=hello+world',
    },
    'url-to-markdown': {
        name: 'apify_url-to-markdown',
        runsSearch: false,
        inputSchema: urlToMarkdownInputSchema,
        mcpServerName: 'mcp-server-url-to-markdown',
        route: Routes.FETCH,
        helpRoute: '/fetch?url=https://example.com',
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
