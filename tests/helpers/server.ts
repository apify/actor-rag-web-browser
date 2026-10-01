import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import express from 'express';

/** Number of times the test image has been requested, used to verify that media files are not downloaded. */
let imageRequestCount = 0;

export function getImageRequestCount(): number {
    return imageRequestCount;
}

export function resetImageRequestCount(): void {
    imageRequestCount = 0;
}

/**
 * Creates and returns an Express server with test routes
 */
export function createTestServer(): express.Express {
    const app = express();

    const sendHtml = (name: string, res: express.Response) => {
        const htmlPath = path.join(__dirname, 'html', name);
        res.send(fs.readFileSync(htmlPath, 'utf-8'));
    };

    app.get('/basic', (_req, res) => {
        sendHtml('basic.html', res);
    });

    app.get('/clickable', (_req, res) => {
        sendHtml('clickable.html', res);
    });

    app.get('/with-image', (_req, res) => {
        sendHtml('with-image.html', res);
    });

    app.get('/with-base', (_req, res) => {
        sendHtml('with-base.html', res);
    });

    // The page above without its `<base>`, reached through a redirect from another path.
    app.get('/redirect/page', (_req, res) => {
        res.redirect('/redirected/page');
    });

    app.get('/redirected/page', (_req, res) => {
        const html = fs.readFileSync(path.join(__dirname, 'html', 'with-base.html'), 'utf-8');
        res.send(html.replace(/<base [^>]*>/, ''));
    });

    // A minimal stand-in for a Google result page, holding a single organic result that points back
    // at this server, so that the search crawler can be exercised without reaching Google.
    app.get('/serp', (req, res) => {
        res.send(`<html><body><div class="MjjYud">
            <a href="http://${req.headers.host}/basic"><h3>Test Page</h3></a>
        </div></body></html>`);
    });

    // What Google serves when it refuses the query: parses fine, holds no results.
    app.get('/serp-empty', (_req, res) => {
        res.send('<html><body><h1>unusual traffic</h1></body></html>');
    });

    app.get('/serp-error', (_req, res) => {
        res.status(500).send('nope');
    });

    // Has no media file extension, so it is not skipped - the crawler rejects its content type instead.
    app.get('/binary', (_req, res) => {
        res.type('application/octet-stream').send(Buffer.from([0x00, 0x01, 0x02]));
    });

    app.get('/image.png', (_req, res) => {
        imageRequestCount++;
        // A 1x1 transparent PNG
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
            'base64',
        );
        res.type('png').send(png);
    });

    return app;
}

/**
 * Starts a test server on the specified port
 * @param port Port number to use
 * @returns HTTP server instance
 */
export function startTestServer(port = 3030): Server {
    const app = createTestServer();
    return app.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`Test server is running on port ${port}`);
    });
}

/**
 * Stops the test server
 * @param server Server instance to stop
 */
export async function stopTestServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}
