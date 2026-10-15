# CLAUDE.md

## What this repo is
One codebase builds two Actors: RAG Web Browser and URL to Markdown (`actors/`). `ACTOR_FULL_NAME` picks which one runs, through `src/mini-actors.ts`. Each runs in normal mode or in Standby mode.

The two Actors differ in whether they run a search, their Standby tenancy and what they charge for. All of it is set per Actor in `MINI_ACTORS` (`src/mini-actors.ts`); read it before changing anything that depends on which Actor is running.

## Commands
- `pnpm build`, `pnpm lint`, `pnpm test`: the same three steps CI runs.
- Tests need Firefox for Playwright: `pnpm exec playwright install firefox`.
- Run tests without `APIFY_TOKEN` in the environment. With a token, the crawlers go through Apify Proxy, which can't reach the local test server.

## Charging
- Every event is pay-per-event. Only a page that fails to load is free.
- Charge before storing a result or sending a response.
- The run's `maxTotalChargeUsd` budget only applies when the user owns the run: a normal run or single-tenant Standby. Multi-tenant Standby bills each caller directly.

## Tests
- Crawler tests use the local server in `tests/helpers/server.ts`, never real websites.
- Crawler-level charging tests mock `src/charging.js`; unit tests of `src/charging.ts` mock the SDK's charging manager.
- Set the inputs a test depends on inside the test itself; shared defaults only for values it doesn't care about.

## Deploys
Manually deploys from platform for both actors.
