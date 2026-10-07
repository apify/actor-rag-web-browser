import type { ProxyConfigurationOptions } from 'apify';
import { Actor } from 'apify';
import { ProxyConfiguration } from 'crawlee';

import type { ContentCrawlerUserData } from './types.js';

/** Bounds the memory taken by the configurations of callers who each send their own proxy settings. */
const MAX_CACHED_PROXY_CONFIGURATIONS = 100;

const proxyConfigurations = new Map<string, Promise<ProxyConfiguration | undefined>>();

/**
 * Creates the proxy configuration for the given options, or takes it from the cache. The platform checks
 * the access to the proxy groups when a configuration is created, and a configuration whose creation
 * failed is not cached.
 *
 * Throws when the options are not valid, or when the account has no access to the requested proxy.
 */
export async function getProxyConfiguration(options: ProxyConfigurationOptions): Promise<ProxyConfiguration | undefined> {
    const key = JSON.stringify(options);

    let cached = proxyConfigurations.get(key);
    if (!cached) {
        cached = Actor.createProxyConfiguration(options);
        proxyConfigurations.set(key, cached);
        cached.catch(() => proxyConfigurations.delete(key));

        if (proxyConfigurations.size > MAX_CACHED_PROXY_CONFIGURATIONS) {
            proxyConfigurations.delete(proxyConfigurations.keys().next().value!);
        }
    }

    return cached;
}

/**
 * The proxy configuration of the content crawlers. It is the same for all of them and for all callers: it
 * picks the proxy for each request from the proxy settings that the request carries, so that callers with
 * different proxy settings can share the crawlers.
 *
 * The settings have been validated when the request was created, so a configuration for them is
 * normally in the cache already, and is only created again if it was evicted in the meantime.
 */
export const contentProxyConfiguration = new ProxyConfiguration({
    newUrlFunction: async (sessionId, options) => {
        const proxyOptions = (options?.request?.userData as Partial<ContentCrawlerUserData> | undefined)
            ?.proxyConfigurationOptions;
        if (!proxyOptions) return null;

        const proxyConfiguration = await getProxyConfiguration(proxyOptions);
        return await proxyConfiguration?.newUrl(sessionId, options) ?? null;
    },
});
