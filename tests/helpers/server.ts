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

/** Starts with front matter, like https://apify.com/agents.md does, and holds syntax that HTML processing would escape. */
export const MARKDOWN_DOCUMENT = [
    '---',
    'name: agent-instructions',
    '---',
    '',
    '# Agent instructions',
    '',
    'Read the *whole* file before you [start](/docs/start).',
    '',
    '```bash',
    '# install the CLI',
    'npm install -g apify-cli',
    '```',
    '',
].join('\n');

/** Markdown by its specification, though served as plain text, and not ASCII, which a browser garbles in a
 * document in UTF-8 that doesn't declare its charset. */
export const LLMS_TXT_DOCUMENT = '# Example docs\n\n> Docs for AI agents: “quotes”, café.\n';

/** Plain text, the first line of which is therefore no heading. */
export const PLAIN_TEXT_DOCUMENT = '# Not a heading\n\nPlain text, returned as it is.\n';

/** Served in windows-1252. */
export const WINDOWS_1252_DOCUMENT = '# Café crème\n';

/** Number of times the browser has revalidated its cached copy of a document, answered with 304 Not Modified. */
let revalidationCount = 0;

export function getRevalidationCount(): number {
    return revalidationCount;
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

    app.get('/agents.md', (_req, res) => {
        res.type('text/markdown; charset=utf-8').send(MARKDOWN_DOCUMENT);
    });

    // Served the way nginx serves a `.txt` file by default: without a charset, and with an ETag. Must be
    // revalidated whenever the browser reuses its cached copy, which is answered with 304 Not Modified, without
    // a body and a content type.
    app.get('/llms.txt', (req, res) => {
        const headers = { ETag: '"llms"', 'Cache-Control': 'no-cache' };
        if (req.headers['if-none-match'] === headers.ETag) {
            revalidationCount++;
            res.writeHead(304, headers).end();
            return;
        }
        res.writeHead(200, { ...headers, 'Content-Type': 'text/plain' }).end(LLMS_TXT_DOCUMENT);
    });

    app.get('/notes.txt', (_req, res) => {
        res.type('text/plain').send(PLAIN_TEXT_DOCUMENT);
    });

    // As GitHub serves raw files.
    app.get('/README.md', (_req, res) => {
        res.type('text/plain').send(MARKDOWN_DOCUMENT);
    });

    app.get('/windows-1252.txt', (_req, res) => {
        res.type('text/plain; charset=windows-1252').send(Buffer.from('2320436166e9206372e86d650a', 'hex'));
    });

    // Sent without a content type, which Crawlee then infers from the URL extension, and a browser from the content.
    app.get('/untyped.md', (_req, res) => {
        res.end(MARKDOWN_DOCUMENT);
    });

    // Saved with a byte order mark, as Windows editors do.
    app.get('/bom.md', (_req, res) => {
        res.type('text/markdown; charset=utf-8').send(Buffer.concat([Buffer.from('efbbbf', 'hex'), Buffer.from(MARKDOWN_DOCUMENT)]));
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
