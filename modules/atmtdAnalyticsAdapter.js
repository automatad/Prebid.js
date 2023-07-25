import CONSTANTS from '../src/constants.json';
import adapter from '../src/AnalyticsAdapter.js';
import adapterManager from '../src/adapterManager.js';
import { config } from '../src/config.js'

/** Prebid Event Handlers */

const ADAPTER_CODE = 'atmtdAnalyticsAdapter'

var isLoggingEnabled = undefined;

const prettyLog = (level, text, isGroup = false, cb = () => {}) => {
  const colors = {
    'log': '#BBBAC6',
    'warn': '#EDAE49',
    'error': '#EF476F',
    'status': '#307473',
  }

  if (isLoggingEnabled === undefined) {
    if (window.localStorage.getItem('__aggLoggingEnabled')) {
      isLoggingEnabled = true
    } else {
      const queryParams = new URLSearchParams(new URL(window.location.href).search)
      isLoggingEnabled = queryParams.has('aggLoggingEnabled')
    }
  }

  if (isLoggingEnabled) {
    if (isGroup) {
      console.groupCollapsed(`%cATD Adapter%c${level.toUpperCase()}%c${text}`, 'margin-right: 5px;background-color: #98473E; padding:0.2rem; border-radius:5px; color:white; font-weight: bold', `margin-right: 5px;background-color: ${colors[level.toLowerCase()]} ; padding:0.2rem; border-radius:5px; color:${level.toLowerCase() === 'status' ? `white` : `black`};font-weight:bold`, 'padding:0.2rem; color:inherit; font-weight: normal')
      try {
        cb();
      } catch (error) {
        console.log(`%cATD Adater%c${'ERROR'}%c${'Error during cb function in prettyLog'}`, 'margin-right: 5px;background-color: #98473E; padding:0.2rem; border-radius:5px; color:white; font-weight: bold', `margin-right: 5px;background-color: ${'#EF476F'} ; padding:0.2rem; border-radius:5px; color:${'black'};font-weight:bold`, 'padding:0.2rem; color:inherit; font-weight: normal');
      }
      console.groupEnd()
    } else {
      console.log(`%cATD Adapter%c${level.toUpperCase()}%c${text}`, 'margin-right: 5px;background-color: #98473E; padding:0.2rem; border-radius:5px; color:white;font-weight:bold', `margin-right: 5px;background-color: ${colors[level.toLowerCase()]} ; padding:0.2rem; border-radius:5px; color:${level.toLowerCase() === 'status' ? `white` : `black`};font-weight:bold`, 'padding:0.2rem; color:inherit; font-weight: normal')
    }
  }
}

var queuePointer = 0
var retryCount = 0
const trialCountMilsMapping = [1500, 3000, 5000, 10000];

const processEvents = () => {
  if (retryCount > trialCountMilsMapping.length) {
    prettyLog('error', `Aggregator still hasn't loaded. Processing que stopped`)
    return;
  }

  prettyLog('status', `Que has been inactive for a while. Adapter starting to process que now... Trial Count = ${retryCount + 1}`)

  let shouldTryAgain = false

  while (queuePointer < __atmtdAnalyticsQueue.length) {
    const eventType = __atmtdAnalyticsQueue[queuePointer][0]
    const args = __atmtdAnalyticsQueue[queuePointer][1]

    let hasEventBeenProcessedSuccessfully = false

    try {
      switch (eventType) {
        case CONSTANTS.EVENTS.AUCTION_INIT:
          if (window.atmtdAnalytics && window.atmtdAnalytics.auctionInitHandler) {
            hasEventBeenProcessedSuccessfully = true
            window.atmtdAnalytics.auctionInitHandler(args);
          } else {
            shouldTryAgain = true
          }
          break;
        case CONSTANTS.EVENTS.BID_RESPONSE:
          if (window.atmtdAnalytics && window.atmtdAnalytics.bidResponseHandler) {
            hasEventBeenProcessedSuccessfully = true
            window.atmtdAnalytics.bidResponseHandler(args);
          }
          break;
        case CONSTANTS.EVENTS.BIDDER_DONE:
          if (window.atmtdAnalytics && window.atmtdAnalytics.bidderDoneHandler) {
            hasEventBeenProcessedSuccessfully = true
            window.atmtdAnalytics.bidderDoneHandler(args);
          }
          break;
        case CONSTANTS.EVENTS.BID_WON:
          if (window.atmtdAnalytics && window.atmtdAnalytics.bidWonHandler) {
            hasEventBeenProcessedSuccessfully = true
            window.atmtdAnalytics.bidWonHandler(args);
          }
          break;
        case CONSTANTS.EVENTS.NO_BID:
          if (window.atmtdAnalytics && window.atmtdAnalytics.noBidHandler) {
            hasEventBeenProcessedSuccessfully = true
            window.atmtdAnalytics.noBidHandler(args);
          }
          break;
        case CONSTANTS.EVENTS.BID_TIMEOUT:
          if (window.atmtdAnalytics && window.atmtdAnalytics.bidderTimeoutHandler) {
            hasEventBeenProcessedSuccessfully = true
            window.atmtdAnalytics.bidderTimeoutHandler(args);
          }
          break;
        case CONSTANTS.EVENTS.AUCTION_DEBUG:
          if (window.atmtdAnalytics && window.atmtdAnalytics.auctionDebugHandler) {
            hasEventBeenProcessedSuccessfully = true
            window.atmtdAnalytics.auctionDebugHandler(args);
          }
          break;
        case 'slotRenderEnded':
          if (window.atmtdAnalytics && window.atmtdAnalytics.slotRenderEndedGPTHandler) {
            hasEventBeenProcessedSuccessfully = true
            window.atmtdAnalytics.slotRenderEndedGPTHandler(args);
          } else {
            prettyLog('error', `Could not process standalone ${eventType} without auctionInit from que as aggregator has not loaded. Will not be trying again ...`, true, () => {
              console.log(`Event Raw Data :`, args)
            });
          }
          break;
        case 'impressionViewable':
          if (window.atmtdAnalytics && window.atmtdAnalytics.impressionViewableHandler) {
            hasEventBeenProcessedSuccessfully = true
            window.atmtdAnalytics.impressionViewableHandler(args);
          } else {
            prettyLog('error', `Could not process standalone ${eventType} without auctionInit from que as aggregator has not loaded. Will not be trying again ...`, true, () => {
              console.log(`Event Raw Data :`, args)
            });
          }
          break;
      }

      if (shouldTryAgain) break;

      if (hasEventBeenProcessedSuccessfully) {
        prettyLog('log', `Sucessfully processed event ${eventType} from que`, true, () => {
          console.log(`Event Raw Data :`, args)
        });
      }
    } catch (error) {
      prettyLog('error', `Unhandled Error while processing ${eventType} of ${queuePointer}th index in the que. Will not be retrying this raw event ...`, true, () => {
        console.log(`The error is `, error)
      })
    }

    queuePointer = queuePointer + 1
  }

  if (shouldTryAgain) {
    if (trialCountMilsMapping[retryCount]) prettyLog('warn', `Adapter failed to process event as aggregator has not loaded. Retrying in ${trialCountMilsMapping[retryCount]}ms ...`);
    setTimeout(processEvents, trialCountMilsMapping[retryCount])
    retryCount = retryCount + 1
  }
}

__atmtdAnalyticsQueue = []

var timer = null;

__atmtdAnalyticsQueue.push = (args) => {
  Array.prototype.push.apply(__atmtdAnalyticsQueue, [args]);
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  if (args[0] === CONSTANTS.EVENTS.AUCTION_INIT) {
    const timeout = parseInt(config.getConfig('bidderTimeout')) + 1500
    timer = setTimeout(() => {
      processEvents()
    }, timeout);
  } else {
    timer = setTimeout(() => {
      processEvents()
    }, 1500);
  }
};

// ANALYTICS ADAPTER

let baseAdapter = adapter({analyticsType: 'endpoint'});
let atmtdAdapter = Object.assign({}, baseAdapter, {

  disableAnalytics() {
    baseAdapter.disableAnalytics.apply(this, arguments);
  },

  track({eventType, args}) {
    switch (eventType) {
      case CONSTANTS.EVENTS.AUCTION_INIT:
        if (window.atmtdAnalytics && window.atmtdAnalytics.auctionInitHandler) {
          prettyLog('status', 'Aggregator loaded, initialising auction through handlers');
          window.atmtdAnalytics.auctionInitHandler(args);
        } else {
          prettyLog('warn', 'Aggregator not loaded, initialising auction through que ...');
          __atmtdAnalyticsQueue.push([eventType, args])
        }
        break;
      case CONSTANTS.EVENTS.BID_RESPONSE:
        if (window.atmtdAnalytics && window.atmtdAnalytics.bidResponseHandler) {
          window.atmtdAnalytics.bidResponseHandler(args);
        } else {
          prettyLog('warn', `Aggregator not loaded, pushing ${eventType} to que instead ...`);
          __atmtdAnalyticsQueue.push([eventType, args])
        }
        break;
      case CONSTANTS.EVENTS.BIDDER_DONE:
        if (window.atmtdAnalytics && window.atmtdAnalytics.bidderDoneHandler) {
          window.atmtdAnalytics.bidderDoneHandler(args);
        } else {
          prettyLog('warn', `Aggregator not loaded, pushing ${eventType} to que instead ...`);
          __atmtdAnalyticsQueue.push([eventType, args])
        }
        break;
      case CONSTANTS.EVENTS.BID_WON:
        if (window.atmtdAnalytics && window.atmtdAnalytics.bidWonHandler) {
          window.atmtdAnalytics.bidWonHandler(args);
        } else {
          prettyLog('warn', `Aggregator not loaded, pushing ${eventType} to que instead ...`);
          __atmtdAnalyticsQueue.push([eventType, args])
        }
        break;
      case CONSTANTS.EVENTS.NO_BID:
        if (window.atmtdAnalytics && window.atmtdAnalytics.noBidHandler) {
          window.atmtdAnalytics.noBidHandler(args);
        } else {
          prettyLog('warn', `Aggregator not loaded, pushing ${eventType} to que instead ...`);
          __atmtdAnalyticsQueue.push([eventType, args])
        }
        break;
      case CONSTANTS.EVENTS.AUCTION_DEBUG:
        if (window.atmtdAnalytics && window.atmtdAnalytics.auctionDebugHandler) {
          window.atmtdAnalytics.auctionDebugHandler(args);
        } else {
          prettyLog('warn', `Aggregator not loaded, pushing ${eventType} to que instead ...`);
          __atmtdAnalyticsQueue.push([eventType, args])
        }
        break;
      case CONSTANTS.EVENTS.BID_TIMEOUT:
        if (window.atmtdAnalytics && window.atmtdAnalytics.bidderTimeoutHandler) {
          window.atmtdAnalytics.bidderTimeoutHandler(args);
        } else {
          prettyLog('warn', `Aggregator not loaded, pushing ${eventType} to que instead ...`);
          __atmtdAnalyticsQueue.push([eventType, args])
        }
        break;
    }
  }
});

(() => {
  const googletag = window.googletag || {cmd: []};
  googletag.cmd.push(() => {
    googletag.pubads().addEventListener('slotRenderEnded', (event) => {
      if (window.atmtdAnalytics && window.atmtdAnalytics.slotRenderEndedGPTHandler) {
        if (window.__atmtdAggregatorFirstAuctionInitialized === true) {
          window.atmtdAnalytics.slotRenderEndedGPTHandler(event)
          return;
        }
      }
      __atmtdAnalyticsQueue.push(['slotRenderEnded', event])
      prettyLog(`warn`, `Aggregator not initialised at auctionInit, exiting slotRenderEnded handler and pushing to que instead`)
    })

    googletag.pubads().addEventListener('impressionViewable', (event) => {
      if (window.atmtdAnalytics && window.atmtdAnalytics.impressionViewableHandler) {
        if (window.__atmtdAggregatorFirstAuctionInitialized === true) {
          window.atmtdAnalytics.impressionViewableHandler(event)
          return;
        }
      }
      __atmtdAnalyticsQueue.push(['impressionViewable', event])
      prettyLog(`warn`, `Aggregator not initialised at auctionInit, exiting impressionViewable handler and pushing to que instead`)
    })
  })
})()

/// /////////// ADAPTER REGISTRATION //////////////

adapterManager.registerAnalyticsAdapter({
  adapter: atmtdAdapter,
  code: ADAPTER_CODE
});

export default atmtdAdapter;