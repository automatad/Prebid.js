import {
  deepClone,
  logError,
  logInfo,
  logMessage,
  logWarn,
} from '../src/utils.js';

import { MODULE_TYPE_RTD } from '../src/activities/modules.js';
import { ajaxBuilder } from '../src/ajax.js';
import { getGlobal } from '../src/prebidGlobal.js';
import { getGptSlotForAdUnitCode } from '../libraries/gptUtils/gptUtils.js';
import { getStorageManager } from '../src/storageManager.js';
import { submodule } from '../src/hook.js';

const storage = getStorageManager({
  moduleType: MODULE_TYPE_RTD,
  moduleName: 'mile',
});

export const subModuleObj = {
  name: 'mile',
  init: init,
  onAuctionInitEvent: onAuctionInit,
  onAuctionEndEvent: onAuctionEnd,
  onBidRequestEvent: onBidRequest,
  onBidResponseEvent: onBidResponse,
  getBidRequestData: onGetBidRequest,
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

let isGPTSlotUsedForSchema;
let rtdData;
let hasFetchFailed;
let fetchTimeOut;
let trafficShapingGranularity = TS_GRANULARITY.SSP;
let userSpecificTSEnabled = false;
let sspsPushedThroughForUser;
let rtdFetchPromise;

function getAdUnit(adUnitCode) {
  const adUnit = pbjs.adUnits.filter((unit) => unit.code === adUnitCode);

  return adUnit.length ? adUnit[0] : undefined;
}

function getKey(adUnitCode) {
  if (isGPTSlotUsedForSchema) {
    const slot = getGptSlotForAdUnitCode(adUnitCode);

    if (!slot) return undefined;
    else return slot.getAdUnitPath();
  } else {
    return adUnitCode;
  }
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

function isAuctionShaped(auctionID) {
  if (auctionShapedStatus[auctionID]) return true;
  else return false;
}

function createRTDDataEndpoint(siteID) {
  return `${RTD_HOST}/rtd.json?siteID=${siteID}`;
}

function fetchRTDData(url, timeout = 1000) {
  if (rtdFetchPromise && rtdFetchPromise.status === 'pending') {
    logWarn(`${LOG_PREFIX}RTD fetch already in progress. Skipping this call.`);
    return rtdFetchPromise;
  }

  const startTime = Date.now();

  rtdFetchPromise = new Promise((resolve, reject) => {
    if (rtdData) {
      logMessage(`${LOG_PREFIX}Response loaded from initial fetch`, rtdData);
      resolve();
    } else {
      fetchTimeOut = setTimeout(
        () => reject(new Error(`Fetch timed out`, { cause: FETCH_FAILED_REASONS.TIMEOUT })),
        timeout - 1
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
              resolve();
            } catch (err) {
              reject(
                new Error(`Incorrect schema`, {
                  cause: FETCH_FAILED_REASONS.INCORRECT_SCHEMA,
                })
              );
            }
          } else {
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
  // return new Promise((resolve) => {
  try {
    const stringifiedResult = storage.getDataFromLocalStorage(
      '__milePushThroughSSPs'
    );

    return stringifiedResult ? JSON.parse(stringifiedResult) : null;
    // storage.getDataFromLocalStorage('__milePushThroughSSPs', (result) => {
    //     sspsPushedThroughForUser = result ? JSON.parse(result) : {}
    //     resolve()
    // })
  } catch {
    // resolve regardless of error
    return {};
  }

  // })
}

function doNotShapeAuction(data, reason) {
  const auctionID = data.auctionId;
  const adUnits = data.adUnits;

  let fetched = !(reason === DISABLED_REASONS.FETCH_TIMEOUT || reason === DISABLED_REASONS.FETCH_FAILED);

  logWarn(
    `${LOG_PREFIX}Traffic shaping has not been enabled for auction with ID ${auctionID} for reason: ${reason}`
  );

  for (let i = 0; i < adUnits.length; i++) {
    const adUnit = adUnits[i];
    let ortb2Imp;

    if (adUnit.ortb2Imp) ortb2Imp = deepClone(adUnit.ortb2Imp);
    else ortb2Imp = {};

    if (ortb2Imp.ext === undefined) ortb2Imp.ext = {};
    if (ortb2Imp.ext.mileRTDMeta === undefined) ortb2Imp.ext.mileRTDMeta = {};

    ortb2Imp.ext.mileRTDMeta = {
      skipped: true,
      enabled: true,
      reason,
      fetched,
    }

    adUnit.ortb2Imp = {...ortb2Imp};
  }
}

function onGetBidRequest(data, callback, config) {
  // inspect/update auction details

  if (!sspsPushedThroughForUser) sspsPushedThroughForUser = getPushedThroughSSPs();

  const auctionID = data.auctionId;
  const url = createRTDDataEndpoint(config.params.siteID);
  const timeout = (config.params && config.params.timeout) || 1000;

  fetchRTDData(url, timeout)
    .then(() => {
      // rtdData = data.response;
      if (rtdData && rtdData.schema && rtdData.schema.fields[0] === 'gptAdUnit') isGPTSlotUsedForSchema = true;

      const { shouldBeShaped, reason } = shouldAuctionBeShaped();

      if (!shouldBeShaped) {
        doNotShapeAuction(data, reason);
        callback();
        return;
      }

      logMessage(
        `${LOG_PREFIX}Traffic shaping has been enabled for auction with ID ${auctionID}`
      );

      console.log(deepClone(data), 'mileBeforeAlterBid');

      auctionShapedStatus[auctionID] = true;
      const updatedAdUnits = [];
      const dataToLog = [];

      for (let i = 0; i < data.adUnits.length; i++) {
        const adUnit = data.adUnits[i];
        const updatedBids = [];
        const dataToLogForAdUnit = {
          code: adUnit.code,
          biddersRemoved: [],
          biddersPushedThrough: [],
        };
        let key, ortb2Imp;

        if (isGPTSlotUsedForSchema) {
          const slot = getGptSlotForAdUnitCode(adUnit.code);

          if (!slot) continue;
          else key = slot.getAdUnitPath();
        } else {
          key = adUnit.code;
        }

        if (adUnit.ortb2Imp) ortb2Imp = adUnit.ortb2Imp;
        else ortb2Imp = {};

        if (ortb2Imp.ext === undefined) ortb2Imp.ext = {};

        ortb2Imp.ext.mileRTDMeta = {
          skipped: false,
          enabled: true,
          reason: '',
          fetched: true,
          shaped: false,
        };

        const biddersAndSizesRemoved = {};
        const biddersAndSizesPushedThrough = {};

        for (let j = 0; j < adUnit.bids.length; j++) {
          const bid = adUnit.bids[j];
          const vals = rtdData.values;

          // Set an empty object for all bidders

          if (vals[key] && vals[key][bid.bidder]) updatedBids.push(bid);
          else if (vals[key] !== undefined) {
            ortb2Imp.ext.mileRTDMeta.shaped = true;

            if (ortb2Imp.ext.mileRTDMeta.removed === undefined) ortb2Imp.ext.mileRTDMeta.removed = {};

            // If the bidder has already been removed, we can ignore the bid and just conitnue

            if (biddersAndSizesRemoved[bid.bidder] === undefined) {
              let hasUserSpecificTrafficShapingBeenPerformed = false;

              if (userSpecificTSEnabled && sspsPushedThroughForUser) {
                const now = Date.now();

                if (
                  sspsPushedThroughForUser[bid.bidder] &&
                  sspsPushedThroughForUser[bid.bidder].validUntil
                ) {
                  if (now < sspsPushedThroughForUser[bid.bidder].validUntil) {
                    hasUserSpecificTrafficShapingBeenPerformed = true;
                    const sizesPushedThroughMap = {};
                    adUnit.mediaTypes.banner.sizes.forEach(
                      ([w, h]) => (sizesPushedThroughMap[`${w}x${h}`] = 1)
                    );
                    biddersAndSizesPushedThrough[bid.bidder] =
                      sizesPushedThroughMap;
                    dataToLogForAdUnit.biddersPushedThrough.push(bid.bidder);
                    updatedBids.push(bid);
                  }
                }
              }

              if (!hasUserSpecificTrafficShapingBeenPerformed) {
                const sizesRemovedMap = {};
                adUnit.mediaTypes.banner.sizes.forEach(
                  ([w, h]) => (sizesRemovedMap[`${w}x${h}`] = 1)
                );
                biddersAndSizesRemoved[bid.bidder] = sizesRemovedMap;
                dataToLogForAdUnit.biddersRemoved.push(bid.bidder);
              }
            }
          } else updatedBids.push(bid);
        }

        const newOrtb2Imp = {
          ...ortb2Imp,
          ext: {
            ...ortb2Imp.ext,
            mileRTDMeta: {
              ...ortb2Imp.ext.mileRTDMeta,
              removed: biddersAndSizesRemoved,
            },
          },
        };

        newOrtb2Imp.ext.mileRTDMeta.userSpecificTSEnabled =
          userSpecificTSEnabled;

        if (Object.keys(biddersAndSizesPushedThrough).length) {
          // Some bidders have been pushed through for user specific ts
          newOrtb2Imp.ext.mileRTDMeta.userSpecificTSPerformed = true;
          newOrtb2Imp.ext.mileRTDMeta.biddersPushedThrough =
            biddersAndSizesPushedThrough;
        } else {
          newOrtb2Imp.ext.mileRTDMeta.userSpecificTSPerformed = false;
        }

        adUnit.ortb2Imp = deepClone(newOrtb2Imp);

        // Add data to log for ad unit

        dataToLog.push(dataToLogForAdUnit);

        adUnit.bids = updatedBids;
        updatedAdUnits.push(adUnit);
      }

      data.adUnits = [...updatedAdUnits];

      callback();

      console.log(data, 'mileAfterAlterBid');
      dataToLog.forEach((data) => {
        const removedBidders = Array.from(new Set(data.biddersRemoved));
        const pushedThrough = Array.from(new Set(data.biddersPushedThrough));
        if (userSpecificTSEnabled) {
          logInfo(
            `${LOG_PREFIX}Pushed through ${pushedThrough.length} bidder(s) for ad unit code ${data.code}`
          );
        }
        if (pushedThrough.length) {
          logInfo(
            `${LOG_PREFIX}Bidder(s) is or are [${pushedThrough.join(',')}]`
          );
        }
        logInfo(
          `${LOG_PREFIX}Removed ${removedBidders.length} bidder(s) from ad unit code ${data.code}`
        );
        if (removedBidders.length) {
          logInfo(
            `${LOG_PREFIX}Bidder(s) is or are [${removedBidders.join(', ')}]`
          );
        }
      });
    })
    .catch((error) => {
      let reason;

      if (error.cause && error.cause === FETCH_FAILED_REASONS.TIMEOUT) {
        reason = DISABLED_REASONS.FETCH_TIMEOUT;
        hasFetchFailed = undefined;
      } else {
        reason = error.cause;
        hasFetchFailed = true;
      }

      doNotShapeAuction(data, reason);

      callback();

      if (hasFetchFailed) logError(`${LOG_PREFIX}Http fetch to ${url} failed`);
    });
}

function onAuctionInit(auctionDetails, config, userConsent) {
}

function onAuctionEnd(data) {
  delete auctionShapedStatus[data.auctionId];
}

function onBidRequest(data) {
  if (trafficShapingGranularity !== TS_GRANULARITY.SIZE) return;

  const auctionID = data.auctionId;

  if (!isAuctionShaped(auctionID)) {
    return;
  }

  const updatedBids = [];
  const dataToLogForAdUnits = {};

  for (let i = 0; i < data.bids.length; i++) {
    const bid = data.bids[i];
    const bidder = bid.bidder;
    const adUnitCode = bid.adUnitCode;
    const adUnit = getAdUnit(adUnitCode);
    const updatedSizes = [];
    const key = getKey(bid.adUnitCode);
    const vals = rtdData.values;

    if (!key || !adUnit) continue;

    let ortb2Imp;

    if (adUnit.ortb2Imp) ortb2Imp = adUnit.ortb2Imp;
    else ortb2Imp = {};

    if (ortb2Imp.ext === undefined) ortb2Imp.ext = {};
    if (ortb2Imp.ext.mileRTDMeta === undefined) {
      ortb2Imp.ext.mileRTDMeta = {
        skipped: false,
        enabled: true,
        reason: '',
        fetched: true,
      };
    }

    if (ortb2Imp.ext.mileRTDMeta.shaped === undefined) ortb2Imp.ext.mileRTDMeta.shaped = false;

    for (let j = 0; j < bid.sizes.length; j++) {
      const [width, height] = bid.sizes[j];
      const size = `${width}x${height}`;

      if (vals[key] && vals[key][bidder] && vals[key][bidder][size]) updatedSizes.push(bid.sizes[j]);
      else if (vals[key] !== undefined && vals[key][bidder] !== undefined) {
        ortb2Imp.ext.mileRTDMeta.shaped = true;

        if (ortb2Imp.ext.mileRTDMeta.removed === undefined) ortb2Imp.ext.mileRTDMeta.removed = {};

        if (ortb2Imp.ext.mileRTDMeta.removed[bidder] === undefined) ortb2Imp.ext.mileRTDMeta.removed[bidder] = { [size]: 2 };
        else ortb2Imp.ext.mileRTDMeta.removed[bidder][size] = 2;
      } else updatedSizes.push(bid.sizes[j]);
    }

    if (updatedSizes.length) {
      bid.sizes = updatedSizes;
      updatedBids.push(bid);
    }

    // Adding the or condition here because the remove[bidder] will be undefined
    // if we have not removed any bidder and size from the request made to the bidder
    const sizesRemoved = Object.keys(
      ortb2Imp.ext.mileRTDMeta.removed[bidder] || {}
    );
    dataToLogForAdUnits[adUnitCode] = sizesRemoved;

    adUnit.ortb2Imp = deepClone(ortb2Imp);
  }

  data.bids = updatedBids;

  Object.keys(dataToLogForAdUnits).forEach((adUnit) => {
    const sizesRemoved = dataToLogForAdUnits[adUnit];
    logInfo(
      `${LOG_PREFIX}Removed ${sizesRemoved.length} sizes from ad unit code ${adUnit} for ${data.bidderCode}`
    );
    if (sizesRemoved.length) logInfo(`${LOG_PREFIX}Sizes removed are [${sizesRemoved.join(', ')}]`);
  });
}

function onBidResponse(bidResponse, config, userConsent) {}

function init(config) {
  if (config.params && config.params.granularity === TS_GRANULARITY.SIZE) trafficShapingGranularity = TS_GRANULARITY.SIZE;
  if (config.params && config.params.user) userSpecificTSEnabled = true;

  logMessage(`${LOG_PREFIX}Initiated with config: `, config);
  // Don't need a catch here because even if it gets rejected due to timeout/failure,
  // The value of rtdDate will be set after the ajax call is completed. This call is just used to
  // call the endpoint asap.
  fetchRTDData(createRTDDataEndpoint(config.params.siteID), config.params && config.params.timeout).catch(() => {});

  return true;
}

function beforeInit() {
  submodule('realTimeData', subModuleObj);
}

beforeInit();