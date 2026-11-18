import { log } from 'crawlee';

import type { RunSummary } from './run-summary.js';

type AlertName = 'standby-run-summary';

function logAlert(alert: AlertName, message: string, data: object) {
    log.info(message, { alert, ...data });
}

export function logStandbyRunSummary({ message, data }: ReturnType<RunSummary['describe']>) {
    logAlert('standby-run-summary', `Run summary: ${message}`, data);
}
