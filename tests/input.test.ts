import { log } from 'crawlee';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { warnIfLowMemoryForPlaywright } from '../src/input.js';

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
