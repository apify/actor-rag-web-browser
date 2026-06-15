import { Actor } from 'apify';
import { log } from 'crawlee';

import { createAndStartContentCrawler, createAndStartSearchCrawler } from './crawlers.js';
import { processInput, processStandbyInput } from './input.js';
import { getMiniActor } from './mini-actors.js';
import { addTimeoutToAllResponses } from './responses.js';
import { handleSearchNormalMode } from './search.js';
import { createServer } from './server.js';
import type { Input } from './types.js';
import { isActorStandby } from './utils.js';

await Actor.init();

Actor.on('migrating', () => {
    addTimeoutToAllResponses(60);
});

const originalInput = await Actor.getInput<Partial<Input>>() ?? {} as Input;

if (isActorStandby()) {
    log.info('Actor is running in the STANDBY mode.');

    const host = Actor.isAtHome() ? process.env.ACTOR_STANDBY_URL as string : 'http://localhost';
    const port = Actor.isAtHome() ? Number(process.env.ACTOR_STANDBY_PORT) : 3000;

    const {
        input,
        searchCrawlerOptions,
        contentCrawlerOptions,
        contentScraperSettings,
    } = await processStandbyInput(originalInput);

    log.debug(`Loaded input: ${JSON.stringify(input)},
        cheerioCrawlerOptions: ${JSON.stringify(searchCrawlerOptions)},
        contentCrawlerOptions: ${JSON.stringify(contentCrawlerOptions)},
        contentScraperSettings ${JSON.stringify(contentScraperSettings)}
    `);

    const app = createServer();

    app.listen(port, async () => {
        const promises: Promise<unknown>[] = [];
        if (getMiniActor().runsSearch) {
            promises.push(createAndStartSearchCrawler(searchCrawlerOptions));
        }
        for (const settings of contentCrawlerOptions) {
            promises.push(createAndStartContentCrawler(settings));
        }

        await Promise.all(promises);
        log.info(`The Actor web server is listening for user requests at ${host}:${port}`);
    });
} else {
    log.info('Actor is running in the NORMAL mode.');

    const processedInput = await processInput(originalInput).catch(async (e: Error) => {
        throw await Actor.fail(`Input processing failed: ${e.message}`);
    });

    const { input, searchCrawlerOptions, contentCrawlerOptions, contentScraperSettings } = processedInput;

    log.debug(`Loaded input: ${JSON.stringify(input)},
        cheerioCrawlerOptions: ${JSON.stringify(searchCrawlerOptions)},
        contentCrawlerOptions: ${JSON.stringify(contentCrawlerOptions)},
        contentScraperSettings ${JSON.stringify(contentScraperSettings)}
    `);

    let stats = { requestsFinished: 0, requestsFailed: 0 };
    try {
        stats = await handleSearchNormalMode(input, searchCrawlerOptions, contentCrawlerOptions, contentScraperSettings);
    } catch (e) {
        const error = e as Error;
        await Actor.fail(error.message as string);
    }
    await Actor.exit(`Finished! Scraped ${stats.requestsFinished} pages, ${stats.requestsFailed} failed.`);
}
