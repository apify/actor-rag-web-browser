import { Actor } from 'apify';
import { log } from 'crawlee';
import { getDomainWithoutSuffix } from 'tldts';

import { TIP_KVS_KEY } from './const.js';

export type ActorTip = {
    message: string;
    level: 'info' | 'warning';
};

type SiteRule = {
    site: string;
    actorTitle: string;
    actorUrl: string;
    domains: string[];
    matchesUrl?: (url: URL) => boolean;
};

function hostnameMatchesDomain(hostname: string, domain: string): boolean {
    const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');

    // `example.*` matches the site under any of its country domains, such as `amazon.co.uk`.
    if (domain.endsWith('.*')) {
        return getDomainWithoutSuffix(normalizedHostname) === domain.slice(0, -2);
    }

    return normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`);
}

function pathStartsWith(pathname: string, segment: string): boolean {
    return pathname === segment || pathname.startsWith(`${segment}/`);
}

/** Specialized Actors we recommend instead of general-purpose scraping. The first matching rule wins. */
const SITE_RULES: SiteRule[] = [
    {
        site: 'Facebook groups',
        actorTitle: 'Facebook Groups Scraper',
        actorUrl: 'https://apify.com/apify/facebook-groups-scraper',
        domains: ['facebook.com'],
        matchesUrl: (url) => pathStartsWith(url.pathname, '/groups'),
    },
    {
        site: 'facebook.com',
        actorTitle: 'Facebook Posts Scraper',
        actorUrl: 'https://apify.com/apify/facebook-posts-scraper',
        domains: ['facebook.com'],
    },
    {
        // Plain Google Search is what this Actor does itself, so only Google Maps gets a recommendation.
        site: 'Google Maps',
        actorTitle: 'Google Maps Scraper',
        actorUrl: 'https://apify.com/compass/crawler-google-places',
        domains: ['google.*'],
        matchesUrl: (url) => url.hostname.startsWith('maps.') || pathStartsWith(url.pathname, '/maps'),
    },
    {
        site: 'zillow.com',
        actorTitle: 'Zillow Detail Scraper',
        actorUrl: 'https://apify.com/maxcopell/zillow-detail-scraper',
        domains: ['zillow.com'],
    },
    {
        site: 'instagram.com',
        actorTitle: 'Instagram Scraper',
        actorUrl: 'https://apify.com/apify/instagram-scraper',
        domains: ['instagram.com'],
    },
    {
        site: 'booking.com',
        actorTitle: 'Booking Scraper',
        actorUrl: 'https://apify.com/voyager/booking-scraper',
        domains: ['booking.com'],
    },
    {
        site: 'tripadvisor.com',
        actorTitle: 'Tripadvisor Scraper',
        actorUrl: 'https://apify.com/maxcopell/tripadvisor',
        domains: ['tripadvisor.*'],
    },
    {
        site: 'youtube.com',
        actorTitle: 'YouTube Scraper',
        actorUrl: 'https://apify.com/streamers/youtube-scraper',
        domains: ['youtube.com', 'youtu.be'],
    },
    {
        site: 'tiktok.com',
        actorTitle: 'TikTok Scraper',
        actorUrl: 'https://apify.com/clockworks/tiktok-scraper',
        domains: ['tiktok.com'],
    },
    {
        site: 'amazon.com',
        actorTitle: 'Amazon Crawler',
        actorUrl: 'https://apify.com/junglee/amazon-crawler',
        domains: ['amazon.*'],
    },
];

/**
 * Without this, whether a domain is recognized in a sentence depends on whether the punctuation after it
 * happens to be a URL delimiter: `zillow.com.` and `zillow.com?` parse fine, `zillow.com,` does not.
 */
const SURROUNDING_PUNCTUATION = /^["'([]+|["')\],.;:!?]+$/g;
const SEARCH_OPERATOR_PREFIX = /^[a-z]+:(?!\/\/)/i;

function interpretTokenAsUrl(token: string): URL | null {
    const candidate = token.replace(SURROUNDING_PUNCTUATION, '').replace(SEARCH_OPERATOR_PREFIX, '');
    if (!candidate.includes('.')) return null;

    try {
        return new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    } catch {
        return null;
    }
}

function findRuleForUrl(url: URL): SiteRule | undefined {
    return SITE_RULES.find((rule) => {
        const matchesDomain = rule.domains.some((domain) => hostnameMatchesDomain(url.hostname, domain));
        return matchesDomain && (rule.matchesUrl?.(url) ?? true);
    });
}

export function findActorTip(input: { query?: string; url?: string }): ActorTip | null {
    const target = input.query || input.url;
    if (!target) return null;

    for (const token of target.split(/\s+/)) {
        if (token.startsWith('-')) continue;

        const url = interpretTokenAsUrl(token);
        const rule = url ? findRuleForUrl(url) : undefined;
        if (!rule) continue;

        return {
            message: `For scraping ${rule.site}, we recommend using [${rule.actorTitle}](${rule.actorUrl})`,
            level: 'info',
        };
    }

    return null;
}

/**
 * Stores the tip under the reserved key-value store key. Call it only once the crawlers have finished:
 * Crawlee purges the default storages while they start up, which wipes a record written before that.
 *
 * A tip is advisory, so a failure to store it never changes the outcome of the run.
 */
export async function storeActorTip(tip: ActorTip | null): Promise<void> {
    if (!tip) return;

    try {
        await Actor.setValue(TIP_KVS_KEY, tip);
    } catch (err) {
        log.warning(`Failed to store the tip: ${err instanceof Error ? err.message : String(err)}`);
    }
}
