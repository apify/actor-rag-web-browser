import { log } from 'crawlee';
import type { Page } from 'playwright';

/**
 * Extensions of media files (images, audio, video and fonts). Such files carry no text
 * for us to extract, so URLs pointing to them are never downloaded.
 */
const MEDIA_FILE_EXTENSIONS = new Set([
    // Images
    'apng', 'avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp',
    // Audio
    'aac', 'flac', 'm4a', 'mid', 'midi', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'weba', 'wma',
    // Video
    '3gp', 'avi', 'flv', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'webm', 'wmv',
    // Fonts
    'eot', 'otf', 'ttf', 'woff', 'woff2',
]);

/**
 * Playwright resource types that never contribute to the extracted content.
 * Stylesheets and scripts are intentionally not blocked, as they affect the rendered page.
 */
const BLOCKED_RESOURCE_TYPES = new Set(['font', 'image', 'media']);

/** Reported as the HTTP status message of a media file we did not download. */
export const SKIPPED_MEDIA_FILE_MESSAGE = 'Skipped media file';

/**
 * Checks whether the URL points to a media file, based on the extension of its last path segment.
 */
export function isMediaUrl(url: string): boolean {
    let pathname: string;
    try {
        pathname = new URL(url).pathname;
    } catch {
        return false;
    }

    const filename = pathname.slice(pathname.lastIndexOf('/') + 1);
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex === -1) return false;

    return MEDIA_FILE_EXTENSIONS.has(filename.slice(dotIndex + 1).toLowerCase());
}

/**
 * Prevents the page from downloading images, audio, video and fonts to save bandwidth.
 * The extracted content is not affected, as these resources contain no text.
 *
 * Playwright invokes the route handlers in the order opposite to their registration, and only
 * the most recently registered one is used unless it defers to the others. Therefore this is called
 * again once the Ghostery blocker registers its own handler, and non-media requests are passed
 * on with `route.fallback()` so that the other handlers still get a chance to process them.
 */
export async function blockMediaRequests(page: Page): Promise<void> {
    try {
        await page.route('**/*', async (route) => {
            const isBlocked = BLOCKED_RESOURCE_TYPES.has(route.request().resourceType());
            try {
                await (isBlocked ? route.abort() : route.fallback());
            } catch {
                // The page might have been closed or navigated away in the meantime.
            }
        });
        log.debug('Media request blocking enabled');
    } catch (err) {
        log.warning(`Failed to enable media request blocking: ${err instanceof Error ? err.message : String(err)}`);
    }
}
