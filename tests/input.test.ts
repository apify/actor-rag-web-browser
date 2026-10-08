import { Actor } from 'apify';
import { log } from 'crawlee';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { processInput, warnIfLowMemoryForPlaywright } from '../src/input.js';
import { parseParameters } from '../src/utils.js';

process.env.ACTOR_FULL_NAME = 'apify/rag-web-browser';

// A custom proxy keeps `Actor.createProxyConfiguration` off the network.
const CALLER_PROXY = encodeURIComponent(JSON.stringify({
    useApifyProxy: false,
    proxyUrls: ['http://caller.invalid:8000'],
}));

describe('warnIfLowMemoryForPlaywright', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('warns only for browser-playwright at or below the low-memory threshold', () => {
        const warning = vi.spyOn(log, 'warning').mockImplementation(() => undefined);

        warnIfLowMemoryForPlaywright('browser-playwright', 1024);
        expect(warning).toHaveBeenCalledOnce();
        expect(warning.mock.calls[0][0]).toContain('1024 MB');

        warning.mockClear();
        warnIfLowMemoryForPlaywright('browser-playwright', 512);
        expect(warning).toHaveBeenCalledOnce();

        warning.mockClear();
        warnIfLowMemoryForPlaywright('browser-playwright', 2048);
        expect(warning).not.toHaveBeenCalled();

        warning.mockClear();
        warnIfLowMemoryForPlaywright('raw-http', 1024);
        expect(warning).not.toHaveBeenCalled();

        warning.mockClear();
        warnIfLowMemoryForPlaywright('browser-playwright', undefined);
        expect(warning).not.toHaveBeenCalled();
    });
});

describe('the log level', () => {
    it('ignores a caller\'s debugMode, which would switch logging for everyone sharing the run', async () => {
        log.setLevel(log.LEVELS.INFO);

        await processInput(parseParameters(`?query=hello&debugMode=true&proxyConfiguration=${CALLER_PROXY}`));

        expect(log.getLevel()).toBe(log.LEVELS.INFO);
    });
});

describe('the shared crawler pool', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('is sized by the run, not by whichever caller happens to build it', async () => {
        vi.spyOn(Actor, 'getEnv').mockReturnValue({ metaOrigin: 'STANDBY' } as never);

        const { contentCrawlerOptions } = await processInput(
            parseParameters(`?query=hello&desiredConcurrency=17&proxyConfiguration=${CALLER_PROXY}`),
        );

        expect(contentCrawlerOptions.crawlerOptions.autoscaledPoolOptions?.desiredConcurrency).toBe(5);
    });
});
