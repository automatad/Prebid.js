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
  SSP: 'ssp',
});
const auctionShapedStatus = {};
const ajax = ajaxBuilder();
const pbjs = getGlobal();

const RTD_HOST = `https://floors.atmtd.com`;
const LOG_PREFIX = 'Mile RTD: ';

let rtdData;
let hasFetchFailed;
let fetchTimeOut;
let trafficShapingGranularity = TS_GRANULARITY.SSP;
let userSpecificTSEnabled = false;
let rtdFetchPromise;

function getKey(adUnitCode) {
  // Always return the adUnitCode - we'll do the matching in makeBidRequestsHook
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

  if (randomNumber > skipRate) {
    return { shouldBeShaped: true, reason: undefined };
  } else {
    return { shouldBeShaped: false, reason: DISABLED_REASONS.SKIPPED };
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

function addMileRTDMeta(bid, skipped, reason, fetched, shaped = false, removed = false, userSpecificTSPerformed = false) {
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
    })
    .catch((error) => {
      // Register the hook even if RTD data fetch fails
      adapterManager.makeBidRequests.after(makeBidRequestsHook);
      logWarn(`${LOG_PREFIX}RTD data fetch failed, but hook registered:`, error);
    });

  return true;
}

function makeBidRequestsHook(fn, bidderRequests) {
  // Early return if RTD data is not available
  if (!rtdData || !rtdData.values) {
    logWarn(`${LOG_PREFIX}RTD data not available, skipping traffic shaping`);
    // Add mileRTDMeta to all bids when RTD data is not available
    bidderRequests.forEach((bidderRequest) => {
      bidderRequest.bids.forEach((bid) => {
        addMileRTDMeta(bid, true, DISABLED_REASONS.FETCH_FAILED, false, false, false, false);
      });
    });
    return fn(bidderRequests);
  }

  // Check if auction should be shaped
  const { shouldBeShaped, reason } = shouldAuctionBeShaped();
  if (!shouldBeShaped) {
    const auctionId = bidderRequests.length > 0 ? bidderRequests[0].auctionId : 'unknown';
    logWarn(
      `${LOG_PREFIX}Traffic shaping has not been enabled for auction with ID ${auctionId} for reason: ${reason}`
    );
    // Add mileRTDMeta to all bids when traffic shaping is skipped
    bidderRequests.forEach((bidderRequest) => {
      bidderRequest.bids.forEach((bid) => {
        addMileRTDMeta(bid, true, reason, true, false, false, false);
      });
    });
    return fn(bidderRequests);
  }

  // Log initial state for openx bidder
  const openxBidderRequest = bidderRequests.find(br => br.bidderCode === 'openx');
  if (openxBidderRequest) {
    logInfo(`${LOG_PREFIX}DEBUG: Initial openx state:`, {
      bidderCode: openxBidderRequest.bidderCode,
      bidsCount: openxBidderRequest.bids.length,
      bids: openxBidderRequest.bids.map(bid => ({
        adUnitCode: bid.adUnitCode,
        sizes: bid.sizes,
        mediaTypes: bid.mediaTypes
      }))
    });
  }

  bidderRequests.forEach((bidderRequest) => {
    const bidderCode = bidderRequest.bidderCode;
    const updatedBids = [];
    const removedSizes = {};

    bidderRequest.bids.forEach((bid) => {
      const adUnitCode = bid.adUnitCode;
      const key = getKey(adUnitCode);
      
      if (!key) {
        // Add mileRTDMeta for bids without a key
        addMileRTDMeta(bid, false, undefined, true, false, false, false);
        updatedBids.push(bid);
        return;
      }

      const vals = rtdData.values;
      // Use endsWith to find matching keys
      let bidderData = null;
      const availableKeys = Object.keys(vals || {});
      
      // First try exact match
      if (vals[key]) {
        bidderData = vals[key];
      } else {
        // Try to find a key that ends with the adUnitCode
        const matchingKey = availableKeys.find(availableKey => 
          availableKey.endsWith(key)
        );
        
        if (matchingKey) {
          bidderData = vals[matchingKey];
        }
      }

      if (!bidderData) {
        // No data for this adUnit combination, allow all bids
        addMileRTDMeta(bid, false, undefined, true, false, false, false);
        updatedBids.push(bid);
        return;
      }

      // Handle size-wise traffic shaping
      let shouldIncludeBid = false;
      let shaped = false;
      let removed = false;
      let userSpecificTSPerformed = false;

      if (trafficShapingGranularity === TS_GRANULARITY.SIZE) {
        const filteredSizes = [];
        const removedSizesForBid = [];

        bid.sizes.forEach(([width, height]) => {
          const size = `${width}x${height}`;
          
          // Check if this specific bidder is allowed for this specific size
          // bidderData should be an object with size keys, and each size should have bidder information
          if (bidderData && typeof bidderData === 'object' && bidderData[size]) {
            if (bidderData[size][bidderCode]) {
              // This bidder is allowed for this size
              filteredSizes.push([width, height]);
            } else {
              // This bidder is not allowed for this size
              removedSizesForBid.push(size);
            }
          } else if (bidderData && bidderData[size]) {
            // Fallback: if bidderData is just size-based (old format)
            filteredSizes.push([width, height]);
          } else {
            // No data for this size, remove it
            removedSizesForBid.push(size);
          }
        });

        if (filteredSizes.length > 0) {
          bid.sizes = filteredSizes;
          
          // Also filter mediaTypes.banner.sizes if it exists
          if (bid.mediaTypes && bid.mediaTypes.banner && bid.mediaTypes.banner.sizes) {
            const originalBannerSizes = [...bid.mediaTypes.banner.sizes];
            const filteredBannerSizes = [];
            bid.mediaTypes.banner.sizes.forEach(([width, height]) => {
              const size = `${width}x${height}`;
              // Check if this size is in our filtered sizes
              if (filteredSizes.some(([fw, fh]) => fw === width && fh === height)) {
                filteredBannerSizes.push([width, height]);
              }
            });
            bid.mediaTypes.banner.sizes = filteredBannerSizes;
          }
          
          shouldIncludeBid = true;
          shaped = removedSizesForBid.length > 0; // Bid was shaped if any sizes were removed
          
          if (removedSizesForBid.length > 0) {
            removedSizes[bidderCode] = removedSizesForBid;
          }
        } else {
          removed = true; // All sizes were removed
        }
      } else {
        // Handle bidder-wise traffic shaping (SSP level)
        // For SSP level, check if this bidder is allowed for this adUnit
        if (bidderData && typeof bidderData === 'object') {
          // Check if any size allows this bidder
          const hasAllowedSize = Object.keys(bidderData).some(size => bidderData[size] && bidderData[size][bidderCode]);
          if (hasAllowedSize) {
            shouldIncludeBid = true;
            shaped = true; // Bid was shaped (allowed through)
            
            // Filter mediaTypes.banner.sizes to only include sizes that allow this bidder
            if (bid.mediaTypes && bid.mediaTypes.banner && bid.mediaTypes.banner.sizes) {
              const filteredBannerSizes = [];
              bid.mediaTypes.banner.sizes.forEach(([width, height]) => {
                const size = `${width}x${height}`;
                if (bidderData[size] && bidderData[size][bidderCode]) {
                  filteredBannerSizes.push([width, height]);
                }
              });
              bid.mediaTypes.banner.sizes = filteredBannerSizes;
            }
          } else {
            removed = true; // Bidder was removed
          }
        } else if (bidderData === true || (typeof bidderData === 'object' && Object.keys(bidderData).length > 0)) {
          // Fallback: old format where bidderData is just a boolean or object
          shouldIncludeBid = true;
          shaped = true; // Bid was shaped (allowed through)
        } else {
          removed = true; // Bidder was removed
        }
      }

      // Handle user-specific traffic shaping
      if (userSpecificTSEnabled) {
        const pushedThroughSSPs = getPushedThroughSSPs();
        if (pushedThroughSSPs && typeof pushedThroughSSPs === 'object' && pushedThroughSSPs[bidderCode]) {
          userSpecificTSPerformed = true;
          shouldIncludeBid = true;
          shaped = true;
        }
      }

      // Add mileRTDMeta to bids that are being processed
      if (shouldIncludeBid) {
        addMileRTDMeta(bid, false, undefined, true, shaped, removed, userSpecificTSPerformed);
        updatedBids.push(bid);
      } else {
        // Bid was removed, still add metadata
        addMileRTDMeta(bid, false, undefined, true, false, true, userSpecificTSPerformed);
      }
    });

    // Update the bidder request with filtered bids
    bidderRequest.bids = updatedBids;
  });

  // Log final state for openx bidder
  const finalOpenxBidderRequest = bidderRequests.find(br => br.bidderCode === 'openx');
  if (finalOpenxBidderRequest) {
    logInfo(`${LOG_PREFIX}DEBUG: Final openx state:`, {
      bidderCode: finalOpenxBidderRequest.bidderCode,
      bidsCount: finalOpenxBidderRequest.bids.length,
      bids: finalOpenxBidderRequest.bids.map(bid => ({
        adUnitCode: bid.adUnitCode,
        sizes: bid.sizes,
        mediaTypes: bid.mediaTypes
      }))
    });
  }

  return fn(bidderRequests);
}

function beforeInit() {
  submodule('realTimeData', subModuleObj);
}

beforeInit();