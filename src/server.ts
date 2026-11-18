import { log } from 'crawlee';
import express, { type Request, type Response } from 'express';

import { getMiniActor } from './mini-actors.js';
import { createRunSummary, startPeriodicSummaryLog } from './run-summary.js';
import { handleSearchRequest } from './search.js';

export function createServer(): express.Express {
    const app = express();
    const miniActor = getMiniActor();

    const HELP_MESSAGE = `Send a GET request to ${process.env.ACTOR_STANDBY_URL}${miniActor.helpRoute}.`;

    const summary = createRunSummary();
    startPeriodicSummaryLog(summary);

    // Counted when the response is sent, so that every route and every error path is counted.
    app.use((_req, res, next) => {
        res.on('finish', () => summary.recordResponse(res.statusCode));
        next();
    });

    app.get('/', async (req, res) => {
        log.info(`Received GET message at: ${req.url}`);
        res.status(200).json({ message: `Actor is running in Standby mode. ${HELP_MESSAGE}` });
    });

    app.get(miniActor.route, async (req: Request, res: Response) => {
        log.info(`Received GET message at: ${req.url}`);
        await handleSearchRequest(req, res, summary);
    });

    app.head(miniActor.route, async (req: Request, res: Response) => {
        log.info(`Received HEAD message at: ${req.url}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end();
    });

    // Catch-all for undefined routes
    app.use((req, res) => {
        res.status(404).json({ message: `There is nothing at route ${req.method} ${req.originalUrl}. ${HELP_MESSAGE}` });
    });

    return app;
}
