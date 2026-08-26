import { log } from 'crawlee';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { warnIfLowMemoryForPlaywright } from '../src/input.js';

describe('warnIfLowMemoryForPlaywright', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('warns when using browser-playwright at 1024 MB', () => {
        const warning = vi.spyOn(log, 'warning').mockImplementation(() => undefined);

        warnIfLowMemoryForPlaywright('browser-playwright', 1024);

        expect(warning).toHaveBeenCalledOnce();
        expect(warning.mock.calls[0][0]).toContain('1024 MB');
    });

    it('warns when memory is below the low-memory threshold', () => {
        const warning = vi.spyOn(log, 'warning').mockImplementation(() => undefined);

        warnIfLowMemoryForPlaywright('browser-playwright', 512);

        expect(warning).toHaveBeenCalledOnce();
    });

    it('does not warn when using browser-playwright with enough memory', () => {
        const warning = vi.spyOn(log, 'warning').mockImplementation(() => undefined);

        warnIfLowMemoryForPlaywright('browser-playwright', 2048);

        expect(warning).not.toHaveBeenCalled();
    });

    it('does not warn when using raw-http regardless of memory', () => {
        const warning = vi.spyOn(log, 'warning').mockImplementation(() => undefined);

        warnIfLowMemoryForPlaywright('raw-http', 1024);

        expect(warning).not.toHaveBeenCalled();
    });

    it('does not warn when memory is unknown', () => {
        const warning = vi.spyOn(log, 'warning').mockImplementation(() => undefined);

        warnIfLowMemoryForPlaywright('browser-playwright', undefined);

        expect(warning).not.toHaveBeenCalled();
    });
});
