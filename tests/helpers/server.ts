import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import express from 'express';

/**
 * Creates and returns an Express server with test routes
 */
export function createTestServer() {
    const app = express();

    app.get('/basic', (_req, res) => {
        const htmlPath = path.join(__dirname, 'html', 'basic.html');
        const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
        res.send(htmlContent);
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
