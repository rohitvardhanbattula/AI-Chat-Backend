// diagnose-connectivity.js — isolates which phase of the on-prem tunnel call
// is stalling: destination lookup, connectivity-proxy JWT/auth exchange, or
// the actual backend request/response.
//
// Run standalone (NOT through the MCP bridge / stdio transport) so verbose
// SDK debug logs can't corrupt anything:
//
//   cds bind --exec node srv/diagnose-connectivity.js --profile hybrid
//
// (use `cds bind --exec ... --profile hybrid` rather than plain `node`, so
// this script gets the same live hybrid-resolved VCAP_SERVICES your app
// gets — running it with plain `node` won't have destination/connectivity
// credentials available.)
//
// Usage: DESTINATION_NAME=AT_DEMO_SYSTEM SAP_USER=rkirlampudi SAP_PASSWORD=*** \
//   cds bind --exec node srv/diagnose-connectivity.js --profile hybrid

'use strict';
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

// Try to turn on verbose SDK logging. Wrapped defensively since the exact
// export surface has changed across @sap-cloud-sdk major versions — if this
// fails, the script still runs, just with default log verbosity.
try {
    const sdkUtil = require('@sap-cloud-sdk/util');
    const contexts = [
        'destination-accessor',
        'destination-service',
        'http-client',
        'http-agent',
        'connectivity-service',
        'jwt',
        'circuit-breaker',
        'resilience',
        'proxy-util',
    ];
    for (const ctx of contexts) {
        try { sdkUtil.setLogLevel('debug', ctx); } catch (_) { /* context may not exist in this SDK version */ }
    }
    console.error('[diagnose] verbose SDK logging enabled for known contexts');
} catch (err) {
    console.error('[diagnose] could not enable verbose SDK logging:', err.message);
}

const DESTINATION_NAME = process.env.DESTINATION_NAME || process.env.SAP_DESTINATION_NAME;
const SAP_USER = process.env.SAP_USER;
const SAP_PASSWORD = process.env.SAP_PASSWORD;

if (!DESTINATION_NAME || !SAP_USER || !SAP_PASSWORD) {
    console.error('Usage: DESTINATION_NAME=<name> SAP_USER=<user> SAP_PASSWORD=<pw> cds bind --exec node srv/diagnose-connectivity.js --profile hybrid');
    process.exit(1);
}

function phase(label) {
    const start = Date.now();
    console.error(`\n── [${label}] starting @ ${new Date(start).toISOString()} ──`);
    return () => {
        const ms = Date.now() - start;
        console.error(`── [${label}] finished in ${ms}ms ──`);
        return ms;
    };
}

async function main() {
    console.error(`Diagnosing destination "${DESTINATION_NAME}"...`);

    // ── Phase 1: destination metadata lookup ────────────────────────────
    let destination;
    const donePhase1 = phase('1. getDestination (metadata lookup)');
    try {
        destination = await getDestination({ destinationName: DESTINATION_NAME });
        donePhase1();
    } catch (err) {
        donePhase1();
        console.error('FAILED at destination lookup:', err.message);
        process.exit(1);
    }

    if (!destination || !destination.url) {
        console.error('FAILED: destination not found or has no URL');
        process.exit(1);
    }

    console.error(`Resolved: url=${destination.url} proxyType=${destination.proxyType} locationId=${destination.locationId || '(empty)'}`);

    // ── Phase 2: the actual tunneled HTTP request ───────────────────────
    // This is the phase that's been hanging ~10s then resetting. Timing it
    // in isolation (with debug logs active) shows whether the stall is in
    // JWT/proxy-auth setup (would show as SDK debug lines before any
    // network activity) or in the actual socket-level request (would show
    // as a gap between the last SDK log line and the eventual reset).
    destination.authentication = 'NoAuthentication';
    const token = Buffer.from(`${SAP_USER}:${SAP_PASSWORD}`).toString('base64');

    const donePhase2 = phase('2. executeHttpRequest (tunneled request)');
    try {
        const response = await executeHttpRequest(
            destination,
            {
                method: 'get',
                url: '/sap/bc/adt/discovery',
                headers: { Authorization: `Basic ${token}` },
                responseType: 'text',
                transformResponse: res => res,
                validateStatus: () => true,
            },
            { fetchCsrfToken: false }
        );
        const ms = donePhase2();
        console.error(`SUCCESS in ${ms}ms — status=${response.status} statusText=${response.statusText}`);
        console.error(`Response body preview: ${String(response.data).slice(0, 200)}`);
    } catch (err) {
        const ms = donePhase2();
        console.error(`FAILED after ${ms}ms:`, err.message);
        if (err.cause) console.error('Cause:', err.cause.message || err.cause);
    }
}

main().catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
});