import { log } from 'crawlee';
import express, { type Request, type Response } from 'express';

import { getMiniActor } from './mini-actors.js';
import { handleSearchRequest } from './search.js';

export function createServer(): express.Express {
    const app = express();
    const miniActor = getMiniActor();

    const HELP_MESSAGE = `Send a GET request to ${process.env.ACTOR_STANDBY_URL}${miniActor.helpRoute}.`;

    app.get('/', async (req, res) => {
        log.info(`Received GET message at: ${req.url}`);
        res.status(200).json({ message: `Actor is running in Standby mode. ${HELP_MESSAGE}` });
    });

    app.get(miniActor.route, async (req: Request, res: Response) => {
        log.info(`Received GET message at: ${req.url}`);
        await handleSearchRequest(req, res);
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
