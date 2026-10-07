import { describe, expect, it } from 'vitest';

import { contentProxyConfiguration, getProxyConfiguration } from '../src/proxy.js';

const requestWithProxy = (proxyUrl?: string) => ({
    userData: { proxyConfigurationOptions: proxyUrl ? { proxyUrls: [proxyUrl] } : undefined },
});

describe('contentProxyConfiguration', () => {
    it('picks the proxy of each request from the proxy settings the request carries', async () => {
        const [first, second] = await Promise.all([
            contentProxyConfiguration.newUrl('session', { request: requestWithProxy('http://first.example:8000') as never }),
            contentProxyConfiguration.newUrl('session', { request: requestWithProxy('http://second.example:8000') as never }),
        ]);

        expect(first).toBe('http://first.example:8000');
        expect(second).toBe('http://second.example:8000');
    });

    it('uses no proxy for a request without proxy settings', async () => {
        const url = await contentProxyConfiguration.newUrl('session', { request: requestWithProxy() as never });

        expect(url).toBeUndefined();
    });

    it('uses no proxy when the caller turned Apify Proxy off', async () => {
        const request = { userData: { proxyConfigurationOptions: { useApifyProxy: false } } };

        expect(await contentProxyConfiguration.newUrl('session', { request: request as never })).toBeUndefined();
    });
});

describe('getProxyConfiguration', () => {
    it('rejects proxy settings the SDK does not accept', async () => {
        await expect(getProxyConfiguration({ apifyProxyCountry: 'xx', password: 'x' }))
            .rejects.toThrow('apifyProxyCountry');
    });

    it('does not cache a failure', async () => {
        const options = { useApifyProxy: true, apifyProxySubdivision: 'CA', password: 'x' };

        await expect(getProxyConfiguration(options)).rejects.toThrow('countryCode');
        await expect(getProxyConfiguration(options)).rejects.toThrow('countryCode');
    });
});
