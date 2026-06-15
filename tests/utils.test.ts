import { describe, expect, it } from 'vitest';

import { interpretAsUrl } from '../src/utils.js';

describe('interpretAsUrl', () => {
    it('should return null for empty input', () => {
        expect(interpretAsUrl('')).toBeNull();
    });

    it('should return null for invalid URL', () => {
        expect(interpretAsUrl('invalid-url')).toBeNull();
    });

    it('should return the URL for valid HTTP URL', () => {
        expect(interpretAsUrl('http://example.com')).toBe('http://example.com/');
    });

    it('should return the URL for valid HTTPS URL', () => {
        expect(interpretAsUrl('https://example.com')).toBe('https://example.com/');
    });

    it('should decode and return the URL for encoded URL', () => {
        expect(interpretAsUrl('https%3A%2F%2Fexample.com')).toBe('https://example.com/');
    });

    it('should return null for non-HTTP/HTTPS protocols', () => {
        expect(interpretAsUrl('ftp://example.com')).toBeNull();
    });

    it('should handle multiple decoding attempts', () => {
        expect(interpretAsUrl('https%253A%252F%252Fexample.com')).toBe('https://example.com/');
    });
});
