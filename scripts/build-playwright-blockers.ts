import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PlaywrightBlocker } from '@ghostery/adblocker-playwright';

async function fetchWrapper(...args: Parameters<typeof fetch>) {
    const response = await fetch(...args);
    if (response.status >= 400) {
        throw new Error(
            `Received HTTP error ${response.status} when fetching '${response.url}': ${response.statusText || 'No details'}`,
        );
    }

    return response;
}

const blockers = {
    'fanboy-cookiemonster': await PlaywrightBlocker.fromLists(
        fetchWrapper,
        [
            'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt', // cookie consent modals
            'https://raw.githubusercontent.com/easylist/easylist/master/fanboy-addon/fanboy_chatapps_third-party.txt', // chat widgets
        ],
        {
            loadNetworkFilters: true,
        },
    ),
};

const targetDir = join(dirname(import.meta.dirname), 'blockers');
await mkdir(targetDir, { recursive: true });

for (const [name, blocker] of Object.entries(blockers)) {
    await writeFile(join(targetDir, `${name}.bin`), blocker.serialize());
}
