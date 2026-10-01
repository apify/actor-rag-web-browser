const MARKDOWN_MIME_TYPES = new Set(['text/markdown', 'text/x-markdown']);

/**
 * Content types of documents that are Markdown or plain text already, such as `agents.md` or `llms.txt`.
 * Their body is returned as it is, as processing it as HTML would escape the Markdown syntax.
 */
export const TEXT_DOCUMENT_MIME_TYPES = new Set([...MARKDOWN_MIME_TYPES, 'text/plain']);

/** Extensions of Markdown documents, which GitHub, for one, serves as plain text. */
const MARKDOWN_EXTENSION_REGEX = /\.(?:md|markdown)$/i;

/** Files that are Markdown by their specification (https://llmstxt.org), whatever their content type. */
const LLMS_TXT_PATHNAMES = new Set(['/llms.txt', '/llms-full.txt']);

/** The title is looked for at the start of a document only, which bounds the time it takes on a large one. */
const TITLE_SEARCH_LENGTH = 64 * 1024;

/** Lines that close the YAML front matter which some Markdown documents start with. */
const FRONT_MATTER_ENDS = new Set(['---', '...']);

/** The opening sequence of an ATX heading of level 1, i.e. `#` followed by a space, a tab or nothing. */
const LEVEL_1_HEADING_PREFIX_REGEX = /^ {0,3}#(?=[ \t]|$)/;

/**
 * @param contentType A `Content-Type` header, or just the MIME type.
 */
function getMimeType(contentType: string | undefined): string | undefined {
    return contentType?.split(';')[0].trim().toLowerCase();
}

export function isTextDocument(contentType: string | undefined): boolean {
    const mimeType = getMimeType(contentType);
    return mimeType !== undefined && TEXT_DOCUMENT_MIME_TYPES.has(mimeType);
}

/**
 * Tells a Markdown document apart from plain text, the same way Website Content Crawler does.
 */
export function isMarkdownDocument(contentType: string | undefined, url: string): boolean {
    const mimeType = getMimeType(contentType);
    if (mimeType !== undefined && MARKDOWN_MIME_TYPES.has(mimeType)) return true;
    if (mimeType !== 'text/plain') return false;

    const pathname = getPathname(url);
    return pathname !== undefined && (MARKDOWN_EXTENSION_REGEX.test(pathname) || LLMS_TXT_PATHNAMES.has(pathname));
}

function getPathname(url: string): string | undefined {
    try {
        return new URL(url).pathname;
    } catch {
        return undefined;
    }
}

function getCharset(contentType: string | undefined): string | undefined {
    for (const parameter of contentType?.split(';').slice(1) ?? []) {
        const separator = parameter.indexOf('=');
        if (separator !== -1 && parameter.slice(0, separator).trim().toLowerCase() === 'charset') {
            return parameter.slice(separator + 1).trim().replace(/"/g, '');
        }
    }
    return undefined;
}

/**
 * @returns The name of the encoding, or `undefined` for a label that a browser doesn't know either.
 */
function getEncoding(label: string): string | undefined {
    try {
        return new TextDecoder(label).encoding;
    } catch {
        return undefined;
    }
}

/**
 * Decodes a text document in UTF-8, the only encoding a browser doesn't recognize by itself: it takes a
 * document that declares no charset for one in a legacy encoding and garbles its text, while it shows the
 * text of any other document right.
 *
 * @returns `undefined` for a document in another encoding, which is then left to the browser.
 */
export function decodeUtf8TextDocument(body: Uint8Array, contentType: string | undefined): string | undefined {
    const charset = getCharset(contentType);
    const encoding = charset === undefined ? undefined : getEncoding(charset);
    if (encoding !== undefined && encoding !== 'utf-8') return undefined;

    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
        return undefined;
    }
}

/**
 * @returns The HTML of the document as a browser shows it, i.e. as preformatted text.
 */
export function textDocumentToHtml(text: string): string {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // A parser drops the line break that follows the start tag, so the one a document may start with is kept.
    return `<pre>\n${escaped}</pre>`;
}

function* readLines(text: string): Generator<string, undefined> {
    const lineEnding = /\r\n?|\n/g;
    let start = 0;
    for (let match = lineEnding.exec(text); match; match = lineEnding.exec(text)) {
        yield text.slice(start, match.index);
        start = lineEnding.lastIndex;
    }
    yield text.slice(start);
    return undefined;
}

/**
 * @returns The text of an ATX heading of level 1, such as `# Title` or `# Title #`.
 */
function parseLevel1Heading(line: string): string | undefined {
    const prefix = LEVEL_1_HEADING_PREFIX_REGEX.exec(line)?.[0];
    if (prefix === undefined) return undefined;

    const content = line.slice(prefix.length).trim();
    // The optional closing sequence of `#` characters, preceded by a space unless it's all there is.
    let end = content.length;
    while (end > 0 && content[end - 1] === '#') end--;
    return end === 0 || content[end - 1] === ' ' || content[end - 1] === '\t'
        ? content.slice(0, end).trimEnd()
        : content;
}

/**
 * Takes the title of a Markdown document from the level 1 heading it starts with, after its front matter,
 * by convention. The heading is looked for only there, so that a line of a code block or of an HTML
 * comment is never taken for one, and with plain string operations, which take linear time on any document.
 *
 * @returns The title, or an empty string when the document doesn't start with a level 1 heading.
 */
export function extractMarkdownTitle(markdown: string): string {
    const lines = readLines(markdown.slice(0, TITLE_SEARCH_LENGTH));
    let line = lines.next().value;

    if (line?.trimEnd() === '---') {
        do {
            line = lines.next().value;
        } while (line !== undefined && !FRONT_MATTER_ENDS.has(line.trimEnd()));
        line = lines.next().value;
    }

    while (line !== undefined && line.trim() === '') {
        line = lines.next().value;
    }

    return line === undefined ? '' : parseLevel1Heading(line) ?? '';
}
