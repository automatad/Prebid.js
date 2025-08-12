import {
  deepClone,
  logInfo,
  logMessage,
  logWarn,
} from '../src/utils.js';

import { MODULE_TYPE_RTD } from '../src/activities/modules.js';
import { ajaxBuilder } from '../src/ajax.js';
import { getGlobal } from '../src/prebidGlobal.js';
import { getStorageManager } from '../src/storageManager.js';
import { submodule } from '../src/hook.js';
import adapterManager from '../src/adapterManager.js';

const storage = getStorageManager({
  moduleType: MODULE_TYPE_RTD,
  moduleName: 'mile',
});

export const subModuleObj = {
  name: 'mile',
  init: init,
  onAuctionInitEvent: onAuctionInit,
  onAuctionEndEvent: onAuctionEnd,
  onBidResponseEvent: onBidResponse,
};

const DISABLED_REASONS = Object.freeze({
  FETCH_FAILED: 'fetchFail',
  FETCH_TIMEOUT: 'fetchTimeout',
  WRONG_SCHEMA: 'wrongSchema',
  SKIPPED: 'skipped',
});
const FETCH_FAILED_REASONS = Object.freeze({
  TIMEOUT: 'timeout',
  FETCH_FAILED: 'fetchFail',
  INCORRECT_SCHEMA: 'incorrectSchema',
});
const TS_GRANULARITY = Object.freeze({
  SIZE: 'size',
  BIDDER: 'bidder',
});
const auctionShapedStatus = {};
const ajax = ajaxBuilder();
const pbjs = getGlobal();

const RTD_HOST = `https://floors.atmtd.com`;
const LOG_PREFIX = 'Mile RTD: ';

let rtdData;
let hasFetchFailed;
let fetchTimeOut;
let trafficShapingGranularity = TS_GRANULARITY.BIDDER;
let userSpecificTSEnabled = false;
let rtdFetchPromise;

function getKey(adUnitCode, bid = null) {
  // If we have a bid with gpid (full GPT path), use that for better matching
  if (bid && bid.ortb2Imp && bid.ortb2Imp.ext && bid.ortb2Imp.ext.gpid) {
    return bid.ortb2Imp.ext.gpid.split('#')[0];
  }
  
  // Fall back to adUnitCode if no gpid available
  logInfo(`${LOG_PREFIX}Debug: No gpid available, using adUnitCode "${adUnitCode}"`);
  return adUnitCode;
}

function shouldAuctionBeShaped() {
  if (hasFetchFailed === undefined) {
    return { shouldBeShaped: false, reason: DISABLED_REASONS.FETCH_TIMEOUT };
  }
  if (hasFetchFailed === true) {
    return { shouldBeShaped: false, reason: DISABLED_REASONS.FETCH_FAILED };
  }

  const { skipRate } = rtdData;
  const randomNumber = Math.floor(Math.random() * 100);
  
  logInfo(`${LOG_PREFIX}Debug: skipRate = ${skipRate}, randomNumber = ${randomNumber}, comparison: ${randomNumber} >= ${100 - skipRate}`);

  // When skipRate is 0, always shape (100% of auctions)
  // When skipRate is 100, never shape (0% of auctions)
  if (randomNumber >= (100 - skipRate)) {
    return { shouldBeShaped: false, reason: DISABLED_REASONS.SKIPPED };
  } else {
    return { shouldBeShaped: true, reason: undefined };
  }
}

function createRTDDataEndpoint(siteID) {
  return `${RTD_HOST}/rtd.json?siteID=${siteID}`;
}

function fetchRTDData(url, timeout = 2000) {
  if (rtdFetchPromise) {
    logWarn(`${LOG_PREFIX}RTD fetch already in progress. Skipping this call.`);
    return rtdFetchPromise;
  }

  const startTime = Date.now();

  rtdFetchPromise = new Promise((resolve, reject) => {
    if (rtdData) {
      logMessage(`${LOG_PREFIX}Response loaded from initial fetch`, rtdData);
      rtdFetchPromise = null; // Reset promise on success
      resolve();
    } else {
      fetchTimeOut = setTimeout(
        () => {
          rtdFetchPromise = null; // Reset promise on timeout
          reject(new Error(`Fetch timed out`, { cause: FETCH_FAILED_REASONS.TIMEOUT }));
        },
        timeout
      );

      ajax(url, {
        success: function (response, req) {
          hasFetchFailed = false;

          clearTimeout(fetchTimeOut);
          fetchTimeOut = undefined;

          if (req.status === 200) {
            try {
              rtdData = JSON.parse(response);
              logMessage(
                `${LOG_PREFIX}Response successfully fetched in ${parseFloat(
                  ((Date.now() - startTime) / 1000).toString()
                ).toFixed(2)}s from ${url}.`,
                JSON.parse(response)
              );
              rtdFetchPromise = null; // Reset promise on success
              resolve();
            } catch (err) {
              rtdFetchPromise = null; // Reset promise on error
              reject(
                new Error(`Incorrect schema`, {
                  cause: FETCH_FAILED_REASONS.INCORRECT_SCHEMA,
                })
              );
            }
          } else {
            rtdFetchPromise = null; // Reset promise on error
            reject(
              new Error(`Non 200 status code`, {
                cause: FETCH_FAILED_REASONS.FETCH_FAILED,
              })
            );
          }
        },
        error: function (_) {
          clearTimeout(fetchTimeOut);
          fetchTimeOut = undefined;
          rtdFetchPromise = null; // Reset promise on error
          reject(
            new Error(`Fetch failed`, {
              cause: FETCH_FAILED_REASONS.FETCH_FAILED,
            })
          );
        },
      });
    }
  });

  return rtdFetchPromise;
}

function getPushedThroughSSPs() {
  try {
    const stringifiedResult = storage.getDataFromLocalStorage(
      '__milePushThroughSSPs'
    );

    return stringifiedResult ? JSON.parse(stringifiedResult) : null;
  } catch {
    // resolve regardless of error
    return {};
  }
}

function addMileRTDMeta(bid, skipped, reason, fetched, shaped = false, removed = false, userSpecificTSPerformed = false, adUnitBasedMileRTDMeta = {}) {
  let ortb2Imp;
  if (bid.ortb2Imp) {
    ortb2Imp = deepClone(bid.ortb2Imp);
  } else {
    ortb2Imp = {};
  }

  if (ortb2Imp.ext === undefined) ortb2Imp.ext = {};
  if (ortb2Imp.ext.mileRTDMeta === undefined) ortb2Imp.ext.mileRTDMeta = {};

  ortb2Imp.ext.mileRTDMeta = {
    skipped,
    enabled: true,
    reason,
    fetched,
    shaped,
    removed,
    userSpecificTSEnabled,
    userSpecificTSPerformed,
  };

  // Preserve the existing object reference by updating properties instead of replacing the entire object
  if (bid.ortb2Imp) {
    // Update the existing ortb2Imp object
    Object.assign(bid.ortb2Imp, ortb2Imp);
  } else {
    // Only create new object if it doesn't exist
    bid.ortb2Imp = ortb2Imp;
  }

  // Also update the ad unit metadata
  const adUnitCode = bid.adUnitCode;
  if (!adUnitBasedMileRTDMeta[adUnitCode]) {
    adUnitBasedMileRTDMeta[adUnitCode] = {
      skipped: false,
      enabled: true,
      reason: '',
      fetched: false,
      shaped: false,
      removed: [],
      userSpecificTSEnabled: false,
      userSpecificTSPerformed: false,
    };
  }
  
  // Update the ad unit metadata with the bid's metadata
  adUnitBasedMileRTDMeta[adUnitCode] = {
    ...adUnitBasedMileRTDMeta[adUnitCode],
    skipped: skipped || adUnitBasedMileRTDMeta[adUnitCode].skipped,
    enabled: true,
    reason: reason || adUnitBasedMileRTDMeta[adUnitCode].reason,
    fetched: fetched || adUnitBasedMileRTDMeta[adUnitCode].fetched,
    shaped: shaped || adUnitBasedMileRTDMeta[adUnitCode].shaped,
    userSpecificTSEnabled: userSpecificTSEnabled || adUnitBasedMileRTDMeta[adUnitCode].userSpecificTSEnabled,
    userSpecificTSPerformed: userSpecificTSPerformed || adUnitBasedMileRTDMeta[adUnitCode].userSpecificTSPerformed,
  };

  // Handle the removed field properly - it should be a list of removed bidders
  if (removed && fetched) {
    // Only process removed bidders if we have RTD data (traffic shaping was possible)
    if (!Array.isArray(adUnitBasedMileRTDMeta[adUnitCode].removed)) {
      adUnitBasedMileRTDMeta[adUnitCode].removed = [];
    }
    // Add bidder to the list if not already there
    if (!adUnitBasedMileRTDMeta[adUnitCode].removed.includes(bid.bidder)) {
      adUnitBasedMileRTDMeta[adUnitCode].removed.push(bid.bidder);
    }
    
    // If any bidders are removed AND we have RTD data, traffic shaping was applied
    adUnitBasedMileRTDMeta[adUnitCode].shaped = true;
  }

  return adUnitBasedMileRTDMeta;
}

function onAuctionInit(auctionDetails, config, userConsent) {
}

function onAuctionEnd(data) {
  delete auctionShapedStatus[data.auctionId];
}

function onBidResponse(bidResponse, config, userConsent) {}

function init(config) {
  if (config.params && config.params.granularity === TS_GRANULARITY.SIZE) trafficShapingGranularity = TS_GRANULARITY.SIZE;
  if (config.params && config.params.user) userSpecificTSEnabled = true;

  logMessage(`${LOG_PREFIX}Initiated with config: `, config);
  
  // Fetch RTD data and register hook after data is available
  fetchRTDData(createRTDDataEndpoint(config.params.siteID), config.params && config.params.timeout)
    .then(() => {
      // Register the hook after RTD data is fetched
      adapterManager.makeBidRequests.after(makeBidRequestsHook);
      logMessage(`${LOG_PREFIX}Hook registered after RTD data fetched`);
      logInfo(`${LOG_PREFIX}Debug: Hook registration complete. Waiting for makeBidRequests to be called...`);
    })
    .catch((error) => {
      // Register the hook even if RTD data fetch fails
      adapterManager.makeBidRequests.after(makeBidRequestsHook);
      logWarn(`${LOG_PREFIX}RTD data fetch failed, but hook registered:`, error);
      logInfo(`${LOG_PREFIX}Debug: Hook registration complete (with error). Waiting for makeBidRequests to be called...`);
    });

  return true;
}

function makeBidRequestsHook(fn, bidderRequests) {
  try {
    logInfo(`${LOG_PREFIX}Hook triggered! Processing ${bidderRequests.length} bidder requests`);
    
    // Early return if RTD data is not available
    if (!rtdData || !rtdData.values) {
      logWarn(`${LOG_PREFIX}RTD data not available, skipping traffic shaping`);
      logInfo(`${LOG_PREFIX}Debug: rtdData =`, rtdData);
    }

    // Check if auction should be shaped
    const { shouldBeShaped, reason } = shouldAuctionBeShaped();
    logInfo(`${LOG_PREFIX}Debug: shouldBeShaped: ${shouldBeShaped}, reason: ${reason}`);

    if (!shouldBeShaped) {
      const auctionId = bidderRequests.length > 0 ? bidderRequests[0].auctionId : 'unknown';
      logWarn(
        `${LOG_PREFIX}Traffic shaping has not been enabled for auction with ID ${auctionId} for reason: ${reason}`
      );
      logInfo(`${LOG_PREFIX}Debug: skipRate = ${rtdData?.skipRate}, hasFetchFailed = ${hasFetchFailed}`);
    }

    // Process all bids regardless of RTD data or traffic shaping status
    logInfo(`${LOG_PREFIX}Processing bids - traffic shaping enabled: ${shouldBeShaped}, granularity: ${trafficShapingGranularity}`);
    const vals = rtdData?.values || {};
    const availableKeys = Object.keys(vals);
    let modifiedAdUnits = {};
    let adUnitBasedMileRTDMeta = {};

    bidderRequests.forEach((bidderRequest) => {
      const bidderCode = bidderRequest.bidderCode;
      const updatedBids = [];
      
      bidderRequest.bids.forEach((bid) => {
        const adUnitCode = bid.adUnitCode;
        const key = getKey(adUnitCode, bid);
        let shouldProcessBid = true;
        let skipReason = undefined;
        
        // Set skip reason if traffic shaping is disabled
        if (!shouldBeShaped) {
          adUnitBasedMileRTDMeta = addMileRTDMeta(bid, true, reason, !!rtdData, false, false, false, adUnitBasedMileRTDMeta);
          updatedBids.push(bid);
          return;
        }

        if (!key) {
          // Add mileRTDMeta for bids without a key
          adUnitBasedMileRTDMeta = addMileRTDMeta(bid, true, 'No key available', !!rtdData, false, false, false, adUnitBasedMileRTDMeta);
          updatedBids.push(bid);
          return;
        }

        // Use endsWith to find matching keys
        let bidderData = null;
        let matchingKey = key; // Default to the original key
        
        // First try exact match
        if (vals[key]) {
          bidderData = vals[key];
          matchingKey = key;
        } else {
          // Try to find a key that ends with the key
          const foundKey = availableKeys.find(availableKey => 
            availableKey.endsWith(key)
          );

          if (foundKey) {
            bidderData = vals[foundKey];
            matchingKey = foundKey;
          }
        }


        if (!bidderData) {
          // No data for this adUnit combination, allow all bids
          adUnitBasedMileRTDMeta = addMileRTDMeta(bid, false, 'No RTD data available', !!rtdData, false, false, false, adUnitBasedMileRTDMeta);
          updatedBids.push(bid);
          return;
        }

        // Handle size-wise traffic shaping
        let shaped = false;
        let removed = false;
        let userSpecificTSPerformed = false;
        let removedSizes = [];
        let filteredSizes = []; // Declare filteredSizes here so it's available in all scopes
        let originalSizes = []; // Declare originalSizes here so it's available in all scopes

        if (trafficShapingGranularity === TS_GRANULARITY.SIZE) {
          const removedSizesForBid = [];
          
          // Capture original sizes BEFORE modification
          originalSizes = bid.mediaTypes?.banner?.sizes || bid.sizes;

          bid.mediaTypes.banner.sizes.forEach(([width, height]) => {
            const size = `${width}x${height}`;
            
            // Check if this specific bidder is allowed for this specific size
            // Data format: bidderData[bidderCode][size]
            if (bidderData && typeof bidderData === 'object' && bidderData[bidderCode]) {
              if (bidderData[bidderCode][size]) {
                // This bidder is allowed for this size
                filteredSizes.push([width, height]);
              } else {
                // This bidder is not allowed for this size
                removedSizesForBid.push(size);
              }
            } else {
              // No data for this bidder or size, remove it
              removedSizesForBid.push(size);
            }
          });

          if (filteredSizes.length > 0) {
            bid.sizes = filteredSizes;
            
            // Also filter mediaTypes.banner.sizes if it exists
            if (bid.mediaTypes && bid.mediaTypes.banner && bid.mediaTypes.banner.sizes) {
              const filteredBannerSizes = [];
              bid.mediaTypes.banner.sizes.forEach(([width, height]) => {
                // Check if this size is in our filtered sizes
                if (filteredSizes.some(([fw, fh]) => fw === width && fh === height)) {
                  filteredBannerSizes.push([width, height]);
                }
              });
              bid.mediaTypes.banner.sizes = filteredBannerSizes;
            }
            
            shouldProcessBid = true;
            shaped = removedSizesForBid.length > 0; // Bid was shaped if any sizes were removed
            removedSizes = removedSizesForBid;
            
            // Size filtering results will be logged per ad unit later
          } else {
            removed = true; // All sizes were removed
          }
        } else {
          // Handle bidder-level traffic shaping
          // For bidder level, simply check if this bidder is allowed
          if (bidderData && bidderData[bidderCode]) {
            const bidderInfo = bidderData[bidderCode];
            
            if (bidderInfo.removed === true) {
              // Entire bidder is removed for this ad unit
              removed = true;
            } else if (Array.isArray(bidderInfo.removed) && bidderInfo.removed.length > 0) {
              // Specific sizes are removed, but bidder is still allowed for other sizes
              shouldProcessBid = true;
              shaped = true; // Bid was shaped (allowed through)
              removedSizes = bidderInfo.removed;
            } else {
              // Bidder is allowed (no removed sizes or removed is false/empty)
              shouldProcessBid = true;
              shaped = true; // Bid was shaped (allowed through)
            }
          } else {
            removed = true; // Bidder was removed
          }
        }

        // Handle user-specific traffic shaping
        if (userSpecificTSEnabled) {
          const pushedThroughSSPs = getPushedThroughSSPs();
          if (pushedThroughSSPs && typeof pushedThroughSSPs === 'object' && pushedThroughSSPs[bidderCode]) {
            userSpecificTSPerformed = true;
            shouldProcessBid = true;
            shaped = true;
          }
        }

        // Add mileRTDMeta to bids that are being processed
        if (shouldProcessBid) {
          adUnitBasedMileRTDMeta = addMileRTDMeta(bid, false, skipReason, !!rtdData, shaped, removed, userSpecificTSPerformed, adUnitBasedMileRTDMeta);
          
          // Only track modifications if actual changes occurred
          if (shaped || removedSizes.length > 0) {
            if (!modifiedAdUnits[matchingKey]) {
              modifiedAdUnits[matchingKey] = {};
            }
            
            if (trafficShapingGranularity === TS_GRANULARITY.SIZE) {
              // Size granularity: track removed sizes, allowed sizes, and original sizes
              const allowedSizes = filteredSizes;
              
              modifiedAdUnits[matchingKey][bidderCode] = { 
                removed: removedSizes,
                allowedSizes: allowedSizes,
                actualSizes: originalSizes
              };
            } else if (trafficShapingGranularity === TS_GRANULARITY.BIDDER && shaped) {
              // Bidder granularity: track that bidder was allowed through
              modifiedAdUnits[matchingKey][bidderCode] = { allowed: true };
            }
          }
          
          updatedBids.push(bid);
        } else {
          // Bid was removed, still add metadata
          adUnitBasedMileRTDMeta = addMileRTDMeta(bid, false, skipReason, !!rtdData, false, true, userSpecificTSPerformed, adUnitBasedMileRTDMeta);
          
          // Track removed bidder in modifiedAdUnits
          if (!modifiedAdUnits[matchingKey]) {
            modifiedAdUnits[matchingKey] = {};
          }
          modifiedAdUnits[matchingKey][bidderCode] = { removed: true };
        }
      });

      // Update the bidder request with filtered bids
      bidderRequest.bids = updatedBids;
    });
    
    // Update ad unit metadata
    logInfo(`${LOG_PREFIX}Debug: adUnitBasedMileRTDMeta:`, adUnitBasedMileRTDMeta);

    Object.keys(adUnitBasedMileRTDMeta).forEach(adUnitCode => {
      const adUnit = pbjs.adUnits.find(au => au.code === adUnitCode);
      if (adUnit) {
        if (!adUnit.ortb2Imp) adUnit.ortb2Imp = {};
        if (!adUnit.ortb2Imp.ext) adUnit.ortb2Imp.ext = {};
        if (!adUnit.ortb2Imp.ext.mileRTDMeta) adUnit.ortb2Imp.ext.mileRTDMeta = {};
        adUnit.ortb2Imp.ext.mileRTDMeta = adUnitBasedMileRTDMeta[adUnitCode];
      } else {
        logWarn(`${LOG_PREFIX}Debug: Ad unit not found for adUnitCode: ${adUnitCode}`);
      }
    });

    logInfo(`${LOG_PREFIX}Debug: modifiedAdUnits:`, modifiedAdUnits);

    return fn(bidderRequests);
  } catch (error) {
    console.error(`${LOG_PREFIX}Error in makeBidRequestsHook:`, error);
    // Return the original bidderRequests without modification if there's an error
    return fn(bidderRequests);
  }
}

function beforeInit() {
  submodule('realTimeData', subModuleObj);
}

beforeInit();