import { Actor } from 'apify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { findActorTip, storeActorTip } from '../src/tips.js';

describe('findActorTip', () => {
    it.each([
        ['https://www.facebook.com/apify/posts', 'For scraping facebook.com, we recommend using [Facebook Posts Scraper](https://apify.com/apify/facebook-posts-scraper)'],
        ['https://www.facebook.com/groups/1234567890', 'For scraping Facebook groups, we recommend using [Facebook Groups Scraper](https://apify.com/apify/facebook-groups-scraper)'],
        ['https://www.zillow.com/homedetails/123', 'For scraping zillow.com, we recommend using [Zillow Detail Scraper](https://apify.com/maxcopell/zillow-detail-scraper)'],
        ['https://www.instagram.com/apify/', 'For scraping instagram.com, we recommend using [Instagram Scraper](https://apify.com/apify/instagram-scraper)'],
        ['https://www.google.com/maps/place/Prague', 'For scraping Google Maps, we recommend using [Google Maps Scraper](https://apify.com/compass/crawler-google-places)'],
        ['https://maps.google.com/?q=prague', 'For scraping Google Maps, we recommend using [Google Maps Scraper](https://apify.com/compass/crawler-google-places)'],
        ['https://www.booking.com/hotel/cz/prague.html', 'For scraping booking.com, we recommend using [Booking Scraper](https://apify.com/voyager/booking-scraper)'],
        ['https://www.tripadvisor.com/Hotel_Review-g274707', 'For scraping tripadvisor.com, we recommend using [Tripadvisor Scraper](https://apify.com/maxcopell/tripadvisor)'],
        ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'For scraping youtube.com, we recommend using [YouTube Scraper](https://apify.com/streamers/youtube-scraper)'],
        ['https://youtu.be/dQw4w9WgXcQ', 'For scraping youtube.com, we recommend using [YouTube Scraper](https://apify.com/streamers/youtube-scraper)'],
        ['https://www.tiktok.com/@apify', 'For scraping tiktok.com, we recommend using [TikTok Scraper](https://apify.com/clockworks/tiktok-scraper)'],
        ['https://www.amazon.com/dp/B08N5WRWNW', 'For scraping amazon.com, we recommend using [Amazon Crawler](https://apify.com/junglee/amazon-crawler)'],
    ])('recommends the Actor listed in the issue for %s', (query, message) => {
        expect(findActorTip({ query })?.message).toBe(message);
    });

    it('marks the tip as informational', () => {
        expect(findActorTip({ query: 'https://www.tiktok.com/@apify' })?.level).toBe('info');
    });

    it.each([
        // The site name appears in the path, not in the host.
        'https://example.com/facebook',
        'https://example.com/redirect?to=https://www.facebook.com/apify',
        // Plain Google Search is what this Actor does itself.
        'https://www.google.com/search?q=prague+restaurants',
        // Hosts that only look like a listed domain.
        'https://notfacebook.com/apify',
        'https://facebook.com.evil.example/apify',
    ])('does not recommend anything for %s', (query) => {
        expect(findActorTip({ query })).toBeNull();
    });

    it.each([
        ['site:instagram.com nike', 'Instagram Scraper'],
        ['cheap hotels booking.com prague', 'Booking Scraper'],
        ['google.com/maps prague restaurants', 'Google Maps Scraper'],
        ['"tripadvisor.com" prague', 'Tripadvisor Scraper'],
    ])('finds a listed domain mentioned in the search query %s', (query, actorTitle) => {
        expect(findActorTip({ query })?.message).toContain(actorTitle);
    });

    it.each([
        'best hotels in prague',
        'site:google.com apify',
        'nike -www.instagram.com',
    ])('does not recommend anything for the search query %s', (query) => {
        expect(findActorTip({ query })).toBeNull();
    });

    it.each([
        ['https://www.amazon.co.uk/dp/B08N5WRWNW', 'Amazon Crawler'],
        ['https://www.amazon.de/dp/B08N5WRWNW', 'Amazon Crawler'],
        ['https://www.amazon.com.mx/dp/B08N5WRWNW', 'Amazon Crawler'],
        ['https://www.google.co.uk/maps/place/Prague', 'Google Maps Scraper'],
        ['https://maps.google.co.uk/?q=prague', 'Google Maps Scraper'],
        ['https://www.tripadvisor.co.uk/Hotel_Review-g274707', 'Tripadvisor Scraper'],
    ])('recognizes the country domain %s', (query, actorTitle) => {
        expect(findActorTip({ query })?.message).toContain(actorTitle);
    });

    it.each([
        // The brand is only a subdomain of someone else's site.
        'https://amazon.abc.com/dp/1',
        'https://amazon.example.com/dp/1',
        'https://notamazon.de/dp/1',
        'https://google.com.evil.example/maps',
        // A country domain does not turn plain Google Search into a Maps request.
        'https://www.google.co.uk/search?q=prague',
    ])('does not read %s as a country domain of a listed site', (query) => {
        expect(findActorTip({ query })).toBeNull();
    });

    it('keeps sites that have a single global domain pinned to it', () => {
        expect(findActorTip({ query: 'https://facebook.ru/apify' })).toBeNull();
        expect(findActorTip({ query: 'https://instagram.de/apify' })).toBeNull();
        expect(findActorTip({ query: 'https://booking.de/hotel/cz/prague.html' })).toBeNull();
    });

    it('matches subdomains, keeping the more specific rule first', () => {
        expect(findActorTip({ query: 'https://m.facebook.com/groups/123' })?.message).toContain('Facebook Groups Scraper');
        expect(findActorTip({ query: 'https://m.facebook.com/apify' })?.message).toContain('Facebook Posts Scraper');
    });

    it('matches a path segment exactly, not merely its prefix', () => {
        expect(findActorTip({ query: 'https://www.facebook.com/groups' })?.message).toContain('Facebook Groups Scraper');
        expect(findActorTip({ query: 'https://www.google.com/maps' })?.message).toContain('Google Maps Scraper');
        expect(findActorTip({ query: 'https://www.facebook.com/groupsomething' })?.message).toContain('Facebook Posts Scraper');
        expect(findActorTip({ query: 'https://www.google.com/mapsomething' })).toBeNull();
    });

    it.each([
        'go to zillow.com for listings',
        'go to zillow.com, and get the listings',
        'go to zillow.com. thanks',
        'go to zillow.com; now',
        'go to zillow.com!',
        'is zillow.com down?',
        'see (zillow.com) for details',
        'see [zillow.com] for details',
        'go to zillow.com...',
    ])('finds the domain whatever punctuation surrounds it: %s', (query) => {
        expect(findActorTip({ query })?.message).toContain('Zillow Detail Scraper');
    });

    it('strips the punctuation before matching a path segment', () => {
        expect(findActorTip({ query: 'google.com/maps, prague' })?.message).toContain('Google Maps Scraper');
    });

    it('ignores the case of the input', () => {
        expect(findActorTip({ query: 'HTTPS://WWW.TIKTOK.COM/@APIFY' })?.message).toContain('TikTok Scraper');
        expect(findActorTip({ query: 'Site:Instagram.com nike' })?.message).toContain('Instagram Scraper');
    });

    it('never throws on tokens that cannot be parsed as a URL', () => {
        expect(findActorTip({ query: 'https:// http://[ .. :: %% "" -' })).toBeNull();
    });

    it('reads `query` first and falls back to `url`', () => {
        expect(findActorTip({ url: 'https://www.tiktok.com/@apify' })?.message).toContain('TikTok Scraper');
        expect(findActorTip({ query: '', url: 'https://www.tiktok.com/@apify' })?.message).toContain('TikTok Scraper');
        expect(findActorTip({ query: 'https://www.tiktok.com/@apify', url: 'https://www.amazon.com/dp/1' })?.message).toContain('TikTok Scraper');
        expect(findActorTip({})).toBeNull();
    });
});

describe('storeActorTip', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('stores the tip under the reserved `TIP` key', async () => {
        const setValue = vi.spyOn(Actor, 'setValue').mockResolvedValue(undefined);
        const tip = { message: 'For scraping tiktok.com, ...', level: 'info' } as const;

        await storeActorTip(tip);

        expect(setValue).toHaveBeenCalledWith('TIP', tip);
    });

    it('writes nothing when there is no tip', async () => {
        const setValue = vi.spyOn(Actor, 'setValue').mockResolvedValue(undefined);

        await storeActorTip(null);

        expect(setValue).not.toHaveBeenCalled();
    });
});
