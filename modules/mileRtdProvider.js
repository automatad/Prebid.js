import { ajaxBuilder } from '../src/ajax.js';
import { submodule } from '../src/hook.js';
import { getGptSlotForAdUnitCode } from '../libraries/gptUtils/gptUtils.js'
import { deepClone, logMessage } from '../src/utils.js';
import { getGlobal } from '../src/prebidGlobal.js';
import { logInfo, logError, logWarn } from '../src/utils.js'


export const subModuleObj = {
    name: 'mileRtd',
    init: init,
    onAuctionInitEvent: onAuctionInit,
    onAuctionEndEvent: onAuctionEnd,
    onBidRequestEvent: onBidRequest,
    onBidResponseEvent: onBidResponse,
    getBidRequestData: onGetBidRequest
};



const DISABLED_REASONS = {
    FETCH_FAILED: 'fetchFail',
    FETCH_TIMEOUT: 'fetchTimeout', 
    WRONG_SCHEMA: 'wrongSchema', 
    SKIPPED: 'skipped' 
}

const 
    auctionShapedStatus = {}, 
    ajax = ajaxBuilder(), 
    pbjs = getGlobal(),
    _rtdData = {
        "schema": {
            "fields": [
                "gptAdUnit"
            ]
        },
        "skipRate": 0,
        "values": {
            "21804848220,22690441817/ATD_RecipeReader/ATD_728x90_Footer": {
                "ttd": {
                "1x1": 1,
                "300x250": 1,
                "325x508": 1
                },
                "sharethrough": {
                "1x1": 1,
                "300x250": 1,
                "325x508": 1
                },
                "rubicon": {
                "1x1": 1
                },
                "pubmatic": {
                "1x1": 1,
                "325x508": 1
                },
                "teads": {
                "1x1": 1,
                "300x250": 1,
                "325x508": 1
                },
                "undertone": {
                "1x1": 1,
                "300x250": 1,
                "325x508": 1
                },
                "rbBidder": {
                "1x1": 1,
                "300x250": 1,
                "325x508": 1
                },
                "medianet": {
                "1x1": 1,
                "300x250": 1,
                "325x508": 1
                },
                "nativo": {
                "300x250": 1,
                "325x508": 1
                },
                "appnexus": {
                "300x250": 1,
                "728x90": 1
                },
                "triplelift": {
                "300x250": 1
                },
                "kargo": {
                "300x250": 1
                },
                "unruly": {
                "325x508": 1
                },
                "openx": {
                "325x508": 1
                }
            },
            "21804848220,22690441817/ATD_RecipeReader/ATD_970x250_EOA_CP": {
                "ttd": {
                "300x250": 1,
                "325x508": 1
                },
                "appnexus": {
                "300x250": 1
                },
                "amx": {
                "300x250": 1,
                "325x508": 1
                },
                "nativo": {
                "300x250": 1
                },
                "criteo": {
                "300x250": 1
                },
                "smartadserver": {
                "300x250": 1,
                "325x508": 1
                },
                "pubmatic": {
                "300x250": 1,
                "325x508": 1
                },
                "ix": {
                "325x508": 1
                },
                "sharethrough": {
                "325x508": 1
                },
                "unruly": {
                "325x508": 1
                },
                "sovrn": {
                "325x508": 1
                },
                "medianet": {
                "325x508": 1
                }
            },
            "21804848220,22690441817/ATD_RecipeReader/ATD_970x250_MH_CP": {
                "pubmatic": {
                "320x100": 1,
                "320x50": 1
                },
                "openx": {
                "320x100": 1,
                "320x50": 1
                },
                "triplelift": {
                "320x100": 1
                },
                "kargo": {
                "320x100": 1,
                "320x50": 1
                },
                "kueezrtb": {
                "320x100": 1,
                "320x50": 1
                },
                "sovrn": {
                "320x100": 1,
                "320x50": 1
                },
                "criteo": {
                "320x100": 1,
                "320x50": 1
                },
                "gumgum": {
                "320x100": 1,
                "320x50": 1
                },
                "medianet": {
                "320x100": 1
                },
                "rubicon": {
                "320x50": 1
                },
                "nativo": {
                "320x50": 1
                },
                "teads": {
                "320x50": 1
                },
                "appnexus": {
                "320x50": 1
                },
                "ogury": {
                "320x50": 1
                }
            }
        }
    }, 
    LOG_PREFIX = 'Mile RTD: '; 

let 
    isGPTSlotUsedForSchema, 
    rtdData, 
    hasFetchFailed; 

function getAdUnit(adUnitCode) {
    const adUnit = pbjs.adUnits.filter((unit) => unit.code === adUnitCode)

    return (adUnit.length ? adUnit[0] : undefined)
}

function getKey(adUnitCode) {
    if (isGPTSlotUsedForSchema) {
        const slot = getGptSlotForAdUnitCode(adUnitCode)

        if (!slot) return undefined; 
        else return slot.getAdUnitPath()
    } else {
        return adUnitCode;
    } 
}

function shouldAuctionBeShaped() {
    if (hasFetchFailed === undefined) return {shouldBeShaped: false, reason: DISABLED_REASONS.FETCH_TIMEOUT}; 
    if (hasFetchFailed === true) return {shouldBeShaped: false, reason: DISABLED_REASONS.FETCH_FAILED}; 

    const 
        { skipRate } = rtdData, 
        randomNumber = Math.floor(Math.random() * 100) 

    if (randomNumber > skipRate) return {shouldBeShaped: true, reason: undefined}; 
    else return {shouldBeShaped: false, reason: DISABLED_REASONS.SKIPPED}; 
}

function isAuctionShaped(auctionID) {
    if (auctionShapedStatus[auctionID]) return true; 
    else return false
}

function createRTDDataEndpoint(siteID) {
    return `https://floors-worker-staging.automatad.workers.dev/rtd.json?siteID=${siteID}`
}

function fetchRTDData(url) {
    return new Promise((resolve, reject) => {
        ajax(url,
            {
                success: function (response, req) {
                    if (req.status === 200) {
                        try {
                            const data = JSON.parse(response);
                            resolve(data)
                        } catch (err) {
                            reject(err)
                        }
                    } 
                    reject(`Http fetch returned non 200 code. Status code ${req.status}`)
                },
                error: function () {
                    reject(`Http fetch failed`)
                }
            }
        );
    })
}

function doNotShapeAuction(data, reason) {
    const 
        auctionID = data.auctionId, 
        adUnits = data.adUnits; 

    let fetched = reason === DISABLED_REASONS.FETCH_FAILED ? false : true

    if (!fetched) {
        logWarn(`${LOG_PREFIX}Traffic shaping has not been enabled for auction with ID ${auctionID} for reason: ${reason}`)
    } else {
        logMessage(`${LOG_PREFIX}Traffic shaping has not been enabled for auction with ID ${auctionID} for reason: ${reason}`)
    }

    for (let i = 0; i < adUnits.length; i++) {

        const adUnit = adUnits[i]; 
        let ortb2Imp; 
        
        if (adUnit.ortb2Imp) ortb2Imp = adUnit.ortb2Imp; 
        else ortb2Imp = {}

        if (ortb2Imp.ext === undefined) ortb2Imp.ext = {}
        if (ortb2Imp.ext.mileRTDMeta === undefined) ortb2Imp.ext.mileRTDMeta = {}

        ortb2Imp.ext.mileRTDMeta = {
            skipped: true, 
            enabled: true, 
            reason, 
            fetched 
        }

    }
}
  
function onGetBidRequest(data, callback, config) {
    // inspect/update auction details

    const auctionID = data.auctionId

    const { shouldBeShaped, reason } = shouldAuctionBeShaped()

    if (!shouldBeShaped) {
        doNotShapeAuction(data, reason)
        callback(); 
        return;
    } 

    logMessage(`${LOG_PREFIX}Traffic shaping has been enabled for auction with ID ${auctionID}`)

    console.log(deepClone(data), 'beforeAlterBid')

    auctionShapedStatus[auctionID] = true
    const updatedAdUnits = [], dataToLog = []

    for (let i = 0; i < data.adUnits.length; i++) {

        const 
            adUnit = data.adUnits[i], 
            updatedBids = [], 
            dataToLogForAdUnit = {
                code: adUnit.code, 
                biddersRemoved: []
            }; 
        let key, ortb2Imp; 

        if (isGPTSlotUsedForSchema) {
            const slot = getGptSlotForAdUnitCode(adUnit.code)

            if (!slot) continue; 
            else key = slot.getAdUnitPath()
        }
        else { 
            key = adUnit.code;
        } 
                
        if (adUnit.ortb2Imp) ortb2Imp = adUnit.ortb2Imp; 
        else ortb2Imp = {}

        if (ortb2Imp.ext === undefined) ortb2Imp.ext = {}
        if (ortb2Imp.ext.mileRTDMeta === undefined) ortb2Imp.ext.mileRTDMeta = {
            skipped: false, 
            enabled: true, 
            reason: '', 
            fetched: true
        }; 
        if (ortb2Imp.ext.mileRTDMeta.shaped === undefined) ortb2Imp.ext.mileRTDMeta.shaped = false

        const  biddersAndSizesRemoved = {}

        for (let j = 0; j < adUnit.bids.length; j++) {
            const 
                bid = adUnit.bids[j],
                vals = rtdData.values; 

            // Set an empty object for all bidders

            if (vals[key] && vals[key][bid.bidder]) updatedBids.push(bid); 
            else if (vals[key] !== undefined) {
                ortb2Imp.ext.mileRTDMeta.shaped = true

                if (ortb2Imp.ext.mileRTDMeta.removed === undefined) ortb2Imp.ext.mileRTDMeta.removed = {}

                if (ortb2Imp.ext.mileRTDMeta.removed[bid.bidder] === undefined) {

                    const sizesRemovedMap = {}
                    adUnit.mediaTypes.banner.sizes.forEach(([w,h]) => sizesRemovedMap[`${w}x${h}`] = 1)
                    biddersAndSizesRemoved[bid.bidder] = sizesRemovedMap

                    dataToLogForAdUnit.biddersRemoved.push(bid.bidder)
                }
            } else updatedBids.push(bid);
        }

        adUnit.ortb2Imp = {
            ...ortb2Imp, 
            ext: {
                ...ortb2Imp.ext, 
                mileRTDMeta: {
                    ...ortb2Imp.ext.mileRTDMeta,
                    removed: biddersAndSizesRemoved
                }
            }
        }

        // Add data to log for ad unit

        dataToLog.push(dataToLogForAdUnit)

        adUnit.bids = updatedBids; 
        updatedAdUnits.push(adUnit); 
    }

    data.adUnits = [...updatedAdUnits]

    callback(); 

    console.log(data, 'afterAlterBid')
    dataToLog.forEach((data) => {
        const removedBidders = Array.from(new Set(data.biddersRemoved))
        logInfo(`${LOG_PREFIX}Removed ${removedBidders.length} bidders from ad unit code ${data.code}`)
        if (removedBidders.length) logInfo(`${LOG_PREFIX}Bidders are [${removedBidders.join(', ')}]`)
    })

}

function onAuctionInit(auctionDetails, config, userConsent) {
    console.log(auctionDetails, config, userConsent, 'auctionInit')
}

function onAuctionEnd(data, config, userConsent) {
    
    delete auctionShapedStatus[data.auctionId]

    console.log(data, config, userConsent, 'auctionEnd')
}

function onBidRequest(data) {

    console.log(deepClone(data), 'beforeBidRequest')

    const auctionID = data.auctionId

    if (!isAuctionShaped(auctionID)) {
        logMessage(`${LOG_PREFIX}Traffic shaping has not been enabled for ${data.bidderCode}'s bid request originating from auction with ID ${auctionID}`)
        return;
    } 

    const updatedBids = [], dataToLogForAdUnits = {}

    for (let i = 0; i < data.bids.length; i++) {
        const   
            bid = data.bids[i], 
            bidder = bid.bidder, 
            adUnitCode = bid.adUnitCode,
            adUnit = getAdUnit(adUnitCode), 
            updatedSizes = [], 
            key = getKey(bid.adUnitCode),
            vals = rtdData.values; 

        if (!key || !adUnit) continue;

        let ortb2Imp;

        if (adUnit.ortb2Imp) ortb2Imp = adUnit.ortb2Imp; 
        else ortb2Imp = {}

        if (ortb2Imp.ext === undefined) ortb2Imp.ext = {}
        if (ortb2Imp.ext.mileRTDMeta === undefined) ortb2Imp.ext.mileRTDMeta = {
            skipped: false, 
            enabled: true, 
            reason: '', 
            fetched: true
        }
        if (ortb2Imp.ext.mileRTDMeta.shaped === undefined) ortb2Imp.ext.mileRTDMeta.shaped = false
        
        for (let j = 0; j < bid.sizes.length; j++) {
            const  
                [ width, height ] = bid.sizes[j]
                size = `${width}x${height}`;  

            if (
                vals[key] 
                && vals[key][bidder] 
                && vals[key][bidder][size]
            ) updatedSizes.push(bid.sizes[j]); 
            else if (vals[key] !== undefined && vals[key][bidder] !== undefined) {
                ortb2Imp.ext.mileRTDMeta.shaped = true

                if (ortb2Imp.ext.mileRTDMeta.removed === undefined) ortb2Imp.ext.mileRTDMeta.removed = {}

                if (ortb2Imp.ext.mileRTDMeta.removed[bidder] === undefined) ortb2Imp.ext.mileRTDMeta.removed[bidder] = {[size]: 2}; 
                else ortb2Imp.ext.mileRTDMeta.removed[bidder][size] = 2
            } else updatedSizes.push(bid.sizes[j]); 
        }

        if (updatedSizes.length) {
            bid.sizes = updatedSizes; 
            updatedBids.push(bid); 
        }

        // Adding the or condition here because the remove[bidder] will be undefined 
        // if we have not removed any bidder and size from the request made to the bidder
        const sizesRemoved = Object.keys(ortb2Imp.ext.mileRTDMeta.removed[bidder] || {})
        dataToLogForAdUnits[adUnitCode] = sizesRemoved

        adUnit.ortb2Imp = ortb2Imp
        
    }

    data.bids = updatedBids

    console.log(data, 'afterBidRequest')

    Object.keys(dataToLogForAdUnits).forEach((adUnit) => {
        const sizesRemoved = dataToLogForAdUnits[adUnit]
        logInfo(`${LOG_PREFIX}Removed ${sizesRemoved.length} sizes from ad unit code ${adUnit} for ${data.bidderCode}`)
        if (sizesRemoved.length) logInfo(`${LOG_PREFIX}Sizes removed are [${sizesRemoved.join(', ')}]`)
    })
}

function onBidResponse(bidResponse, config, userConsent) {
    console.log(bidResponse, config, userConsent, 'onBidResponse')
}

function init(config) {
    // do init stuff

    const url = createRTDDataEndpoint(config.params.siteID), startTime = Date.now()

    fetchRTDData(url)
    .then((response) => {
        console.log(response)
        hasFetchFailed = false
        rtdData = _rtdData
        if (rtdData.schema.fields[0] === 'gptAdUnit') isGPTSlotUsedForSchema = true
        logMessage(`${LOG_PREFIX}Response successfully fetched in ${parseFloat(((Date.now() - startTime)/1000).toString()).toFixed(2)}s from ${url}`)
        //logMessage(`${LOG_PREFIX}Response ${response.text()}`)
    }).catch((err) => {
        hasFetchFailed = true
        logError(err)
    })

    return true;
   
}

function beforeInit() {
    submodule('realTimeData', subModuleObj);
}

beforeInit();
