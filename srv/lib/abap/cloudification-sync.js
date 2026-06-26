'use strict';

const { GITHUB_BASE, SAP_RELEASE_VERSION } = require('../utils/constants');

let cloudificationCache = [];
let syncInProgress      = false;
let syncCompletedAt     = null;
const SYNC_TTL_MS       = 60 * 60 * 1000;

let cacheByName    = new Map();
let successorNames = new Set();

async function fetchJSON(url, timeoutMs = 15_000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: ac.signal });
        if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
        return response.json();
    } finally {
        clearTimeout(timer);
    }
}

async function syncCloudificationData() {
    if (syncInProgress) return;
    syncInProgress = true;

    console.log('syncCloudificationData: starting fetch from GitHub...');
    const entries = [];

    const [tier1Data, tier2Data] = await Promise.allSettled([
        fetchJSON(`${GITHUB_BASE}/objectReleaseInfo_${SAP_RELEASE_VERSION}.json`),
        fetchJSON(`${GITHUB_BASE}/objectClassifications.json`)
    ]);

    if (tier1Data.status === 'fulfilled') {
        const items = tier1Data.value?.objectReleaseInfo || tier1Data.value || [];
        for (const item of items) {
            try {
                const name = item.objectKey?.toUpperCase() || item.tadirObjName?.toUpperCase();
                if (!name) continue;
                const successor = item.successors?.[0]?.tadirObjName?.toUpperCase() || null;
                const state     = item.state?.toLowerCase();
                entries.push({
                    object: name,
                    successor,
                    type:  item.objectType || item.tadirObject,
                    state: state === 'deprecated' ? 'DEPRECATED' : 'RELEASED',
                    tier:  1
                });
            } catch { /* ignore */ }
        }
    }

    if (tier2Data.status === 'fulfilled') {
        const tier1Names = new Set(entries.filter(e => e.tier === 1).map(e => e.object));
        const items = tier2Data.value?.objectClassifications || tier2Data.value || [];
        for (const item of items) {
            try {
                const name = item.objectKey?.toUpperCase() || item.tadirObjName?.toUpperCase();
                if (!name || tier1Names.has(name)) continue;

                const rawState = (item.state || '').toLowerCase().replace(/[\s_]/g, '');
                let state = 'CLASSIC_API';
                if      (rawState === 'released')       state = 'RELEASED';
                else if (rawState === 'deprecated')      state = 'DEPRECATED';
                else if (rawState === 'nottobereleased') state = 'NOT_TO_BE_RELEASED';
                
                const successor = item.successors?.[0]?.tadirObjName?.toUpperCase() || null;
                entries.push({ object: name, successor, type: item.objectType || item.tadirObject, state, tier: 2 });
            } catch { /* ignore */ }
        }
    }

    cloudificationCache = entries;
    rebuildCacheLookups();
    syncCompletedAt = Date.now();
    syncInProgress  = false;
    console.log(`syncCloudificationData: loaded ${cloudificationCache.length} entries`);
}

function rebuildCacheLookups() {
    cacheByName    = new Map(cloudificationCache.map(e => [e.object, e]));
    successorNames = new Set(
        cloudificationCache.flatMap(e => e.successor ? [e.successor] : [])
    );
}

function getCloudificationCache() {
    if (syncCompletedAt && (Date.now() - syncCompletedAt > SYNC_TTL_MS)) {
        syncCloudificationData().catch(err =>
            console.error('syncCloudificationData background refresh failed:', err?.message)
        );
    }
    return { cloudificationCache, cacheByName, successorNames };
}

// Kick off initial load
syncCloudificationData().catch(err => console.error('Initial cloudification load failed:', err?.message));

module.exports = { syncCloudificationData, getCloudificationCache };