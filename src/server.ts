import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { log } from 'crawlee';
import express, { type Request, type Response } from 'express';

import { Routes } from './const.js';
import { RagWebBrowserServer } from './mcp/server.js';
import { handleSearchRequest } from './search.js';

export function createServer(): express.Express {
    const app = express();
    const mcpServer = new RagWebBrowserServer();
    let transport: SSEServerTransport;

    const HELP_MESSAGE = `Send a GET request to ${process.env.ACTOR_STANDBY_URL}/search?query=hello+world`
        + ` or to ${process.env.ACTOR_STANDBY_URL}/message to use Model context protocol.`;

    app.get('/', async (req, res) => {
        log.info(`Received GET message at: ${req.url}`);
        res.status(200).json({ message: `Actor is running in Standby mode. ${HELP_MESSAGE}` });
    });

    app.get(Routes.SEARCH, async (req: Request, res: Response) => {
        log.info(`Received GET message at: ${req.url}`);
        await handleSearchRequest(req, res);
    });

    app.head(Routes.SEARCH, async (req: Request, res: Response) => {
        log.info(`Received HEAD message at: ${req.url}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end();
    });

    app.get(Routes.SSE, async (req: Request, res: Response) => {
        log.info(`Received GET message at: ${req.url}`);
        transport = new SSEServerTransport(Routes.MESSAGE, res);
        await mcpServer.connect(transport);
    });

    app.post(Routes.MESSAGE, async (req: Request, res: Response) => {
        log.info(`Received POST message at: ${req.url}`);
        await transport.handlePostMessage(req, res);
    });

    // Catch-all for undefined routes
    app.use((req, res) => {
        res.status(404).json({ message: `There is nothing at route ${req.method} ${req.originalUrl}. ${HELP_MESSAGE}` });
    });

    return app;
}
