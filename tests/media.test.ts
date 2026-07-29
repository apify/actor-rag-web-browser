import { describe, expect, it } from 'vitest';

import { isMediaUrl } from '../src/media.js';

describe('isMediaUrl', () => {
    it('should detect image, audio, video and font files', () => {
        expect(isMediaUrl('https://example.com/photo.jpg')).toBe(true);
        expect(isMediaUrl('https://example.com/assets/logo.SVG')).toBe(true);
        expect(isMediaUrl('https://example.com/podcast/episode-1.mp3')).toBe(true);
        expect(isMediaUrl('https://example.com/video.mp4')).toBe(true);
        expect(isMediaUrl('https://example.com/fonts/inter.woff2')).toBe(true);
    });

    it('should detect media files with a query string or a fragment', () => {
        expect(isMediaUrl('https://example.com/photo.png?width=100')).toBe(true);
        expect(isMediaUrl('https://example.com/photo.png#preview')).toBe(true);
    });

    it('should not detect web pages as media files', () => {
        expect(isMediaUrl('https://example.com')).toBe(false);
        expect(isMediaUrl('https://example.com/article')).toBe(false);
        expect(isMediaUrl('https://example.com/article.html')).toBe(false);
        expect(isMediaUrl('https://example.com/article.php?image=photo.jpg')).toBe(false);
    });

    it('should only consider the extension of the last path segment', () => {
        expect(isMediaUrl('https://example.com/photo.jpg/details')).toBe(false);
        expect(isMediaUrl('https://example.com/v1.0/article')).toBe(false);
    });

    it('should return false for values that are not valid URLs', () => {
        expect(isMediaUrl('')).toBe(false);
        expect(isMediaUrl('not-a-url.mp4')).toBe(false);
    });
});
