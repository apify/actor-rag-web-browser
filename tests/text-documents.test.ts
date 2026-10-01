import { describe, expect, it } from 'vitest';

import { extractMarkdownTitle } from '../src/text-documents.js';

// By convention, a Markdown document is titled by the level 1 heading it starts with. A heading elsewhere is
// not taken for the title, so that a `# comment` in a code block can't be either.
describe('extractMarkdownTitle', () => {
    it('should take the level 1 heading the document starts with', () => {
        expect(extractMarkdownTitle('# Title\n\nText\n')).toBe('Title');
        expect(extractMarkdownTitle('---\ntitle: Front matter\n---\n\n# Title\n')).toBe('Title');
    });

    it('should be empty when the document does not start with a level 1 heading', () => {
        expect(extractMarkdownTitle('Intro\n\n# Title\n')).toBe('');
        expect(extractMarkdownTitle('```bash\n# install\n```\n')).toBe('');
        expect(extractMarkdownTitle('## Section\n')).toBe('');
    });

    // It runs synchronously on untrusted documents, in a standby run that serves many requests at once.
    it('should take linear time on crafted documents', () => {
        const started = Date.now();
        extractMarkdownTitle(`# a${' '.repeat(50_000)}b`);
        extractMarkdownTitle(`${'`'.repeat(5_000)}\n${'x'.repeat(100_000)}`);
        expect(Date.now() - started).toBeLessThan(200);
    });
});
