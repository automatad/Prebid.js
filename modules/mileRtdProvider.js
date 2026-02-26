/**
 * This module adds Mile provider to the real time data module.
 * It listens to AUCTION_END, gathers auction bids, and delegates
 * floor/hash targeting logic to an external JS runtime loaded over network.
 * @module modules/mileRtdProvider
 * @requires module:modules/realTimeData
 */
import {submodule} from '../src/hook.js';
import {loadExternalScript} from '../src/adloader.js';
import {MODULE_TYPE_RTD} from '../src/activities/modules.js';
import {logError, logInfo} from '../src/utils.js';
const MODULE_NAME = 'realTimeData';
const SUBMODULE_NAME = 'mile';
const TARGETING_KEY = 'mile_rtd';
const LOG_PREFIX = '[mileRtdProvider]';
const DEFAULT_ENGINE_GLOBAL = 'mileRtdRuntime';
let moduleParams = {};
let engineLoadPromise = null;
function extractGpid(obj) {
  return obj?.ortb2Imp?.ext?.gpid || obj?.ortb2Imp?.ext?.data?.pbadslot || obj?.gpid;
}
export function getGpidByAdUnit(auctionDetails = {}) {
  const gpidByAdUnit = {};
  (auctionDetails?.adUnits || []).forEach((adUnit) => {
    const gpid = extractGpid(adUnit);
    if (adUnit?.code && gpid) {
      gpidByAdUnit[adUnit.code] = gpid;
    }
  });
  (auctionDetails?.bidderRequests || []).forEach((request) => {
    (request?.bids || []).forEach((bid) => {
      const gpid = extractGpid(bid);
      if (bid?.adUnitCode && gpid && !gpidByAdUnit[bid.adUnitCode]) {
        gpidByAdUnit[bid.adUnitCode] = gpid;
      }
    });
  });
  (auctionDetails?.bidsReceived || []).forEach((bid) => {
    const gpid = extractGpid(bid);
    if (bid?.adUnitCode && gpid && !gpidByAdUnit[bid.adUnitCode]) {
      gpidByAdUnit[bid.adUnitCode] = gpid;
    }
  });
  return gpidByAdUnit;
}
export function getHighestBidByAdUnit(bidsReceived = []) {
  return bidsReceived.reduce((highestByAdUnit, bid) => {
    const adUnitCode = bid?.adUnitCode;
    const cpm = Number(bid?.cpm);
    if (!adUnitCode || !Number.isFinite(cpm)) {
      return highestByAdUnit;
    }
    const currentHighest = highestByAdUnit[adUnitCode];
    if (!Number.isFinite(currentHighest) || cpm > currentHighest) {
      highestByAdUnit[adUnitCode] = cpm;
    }
    return highestByAdUnit;
  }, {});
}
export function getBidCountsByAdUnit(auctionDetails = {}) {
  const requestedByAdUnit = {};
  const receivedByAdUnit = {};
  (auctionDetails?.bidderRequests || []).forEach((request) => {
    (request?.bids || []).forEach((bid) => {
      if (bid?.adUnitCode) {
        requestedByAdUnit[bid.adUnitCode] = (requestedByAdUnit[bid.adUnitCode] || 0) + 1;
      }
    });
  });
  (auctionDetails?.bidsReceived || []).forEach((bid) => {
    if (bid?.adUnitCode) {
      receivedByAdUnit[bid.adUnitCode] = (receivedByAdUnit[bid.adUnitCode] || 0) + 1;
    }
  });
  return {requestedByAdUnit, receivedByAdUnit};
}
export function extractAuctionSnapshot(auctionDetails = {}) {
  const gpidByAdUnit = getGpidByAdUnit(auctionDetails);
  const highestBidByAdUnit = getHighestBidByAdUnit(auctionDetails?.bidsReceived || []);
  const {requestedByAdUnit, receivedByAdUnit} = getBidCountsByAdUnit(auctionDetails);
  return {
    adUnitCodes: auctionDetails?.adUnitCodes || [],
    gpidByAdUnit,
    highestBidByAdUnit,
    requestedByAdUnit,
    receivedByAdUnit
  };
}
function wasFloorsEnforced(auctionDetails = {}) {
  const bidsFromRequests = (auctionDetails?.bidderRequests || []).flatMap((request) => request?.bids || []);
  const receivedBids = auctionDetails?.bidsReceived || [];
  const allAuctionBids = bidsFromRequests.concat(receivedBids);
  return allAuctionBids.some((bid) => bid?.floorData?.skipped === false);
}
function getRuntimeEngine() {
  const globalName = moduleParams?.runtimeGlobalName || DEFAULT_ENGINE_GLOBAL;
  return window?.[globalName];
}
export function loadRuntimeScript() {
  if (engineLoadPromise) {
    return engineLoadPromise;
  }
  const runtimeScriptUrl = moduleParams?.runtimeScriptUrl;
  if (!runtimeScriptUrl) {
    return Promise.resolve(false);
  }
  engineLoadPromise = new Promise((resolve) => {
    loadExternalScript(
      runtimeScriptUrl,
      MODULE_TYPE_RTD,
      SUBMODULE_NAME,
      () => {
        logInfo(LOG_PREFIX, 'runtime script loaded', runtimeScriptUrl);
        resolve(true);
      }
    );
  }).catch((error) => {
    logError(LOG_PREFIX, 'unable to load runtime script', error);
    engineLoadPromise = null;
    return false;
  });
  return engineLoadPromise;
}
export function getTargetingFromRuntime(auctionSnapshot) {
  const runtimeEngine = getRuntimeEngine();
  if (!runtimeEngine || typeof runtimeEngine.getMileTargetingByAdUnit !== 'function') {
    logInfo(LOG_PREFIX, 'runtime engine missing getMileTargetingByAdUnit()');
    return Promise.resolve(null);
  }
  try {
    const result = runtimeEngine.getMileTargetingByAdUnit(auctionSnapshot);
    return Promise.resolve(result);
  } catch (error) {
    logError(LOG_PREFIX, 'runtime engine failed while computing targeting', error);
    return Promise.resolve(null);
  }
}
export function setSlotTargeting(targetingByAdUnit, googletag = window.googletag) {
  if (!googletag?.cmd?.push || typeof googletag.pubads !== 'function') {
    logInfo(LOG_PREFIX, 'GPT is not available, skipping slot targeting');
    return false;
  }
  logInfo(LOG_PREFIX, 'queueing slot targeting', targetingByAdUnit);
  googletag.cmd.push(() => {
    const slots = googletag.pubads()?.getSlots?.() || [];
    logInfo(LOG_PREFIX, 'found GPT slots', slots.length);
    slots.forEach((slot) => {
      if (typeof slot?.setTargeting !== 'function') {
        return;
      }
      const slotElementId = slot.getSlotElementId?.();
      const adUnitPath = slot.getAdUnitPath?.();
      const targetingValue = targetingByAdUnit[slotElementId] ?? targetingByAdUnit[adUnitPath];
      if (targetingValue != null) {
        logInfo(LOG_PREFIX, 'setting targeting', {
          slotElementId,
          adUnitPath,
          key: TARGETING_KEY,
          value: targetingValue
        });
        slot.setTargeting(TARGETING_KEY, targetingValue);
      }
    });
  });
  return true;
}
export function onAuctionEndEvent(auctionDetails) {
  logInfo(LOG_PREFIX, 'AUCTION_END received', auctionDetails);
  if (!wasFloorsEnforced(auctionDetails)) {
    logInfo(LOG_PREFIX, 'skipping mile targeting because floors were not enforced for this auction');
    return;
  }
  const auctionSnapshot = extractAuctionSnapshot(auctionDetails);
  logInfo(LOG_PREFIX, 'auction snapshot prepared for runtime', auctionSnapshot);
  loadRuntimeScript()
    .then(() => getTargetingFromRuntime(auctionSnapshot))
    .then((targetingByAdUnit) => {
      if (targetingByAdUnit && Object.keys(targetingByAdUnit).length > 0) {
        logInfo(LOG_PREFIX, 'runtime targeting resolved', targetingByAdUnit);
        setSlotTargeting(targetingByAdUnit);
      } else {
        logInfo(LOG_PREFIX, 'runtime returned no targeting');
      }
    });
}
export function init(moduleConfig) {
  moduleParams = moduleConfig?.params || {};
  if (moduleParams?.runtimeScriptUrl) {
    loadRuntimeScript();
  } else {
    logInfo(LOG_PREFIX, 'runtimeScriptUrl not provided; runtime script will not load');
  }
  return true;
}
export const mileRtdSubmodule = {
  name: SUBMODULE_NAME,
  init,
  onAuctionEndEvent
};
export const __testing__ = {
  setModuleParams(params) {
    moduleParams = params || {};
    engineLoadPromise = null;
  }
};
submodule(MODULE_NAME, mileRtdSubmodule);