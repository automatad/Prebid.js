# Overview

```
Module Name: Mile Bid Adapter
Module Type: Bidder Adapter
Maintainer: your-email@example.com
```

# Description

This adapter connects to the Mile Prebid Server for bidding and user synchronization.

# Features

- User syncs via cookie sync endpoint
- Support for Banner, Video, and Native media types
- GDPR, CCPA, and GPP consent handling

# Bid Params

| Name          | Scope    | Description                       | Example          | Type   |
|---------------|----------|-----------------------------------|------------------|--------|
| `placementId` | required | The placement ID for the ad unit  | `'12345'`        | string |

# Example Configuration

```javascript
var adUnits = [{
    code: 'banner-ad-unit',
    mediaTypes: {
        banner: {
            sizes: [[300, 250], [728, 90]]
        }
    },
    bids: [{
        bidder: 'mile',
        params: {
            placementId: '12345'
        }
    }]
}];
```

# User Sync Configuration

To enable user syncing, configure Prebid.js with:

```javascript
pbjs.setConfig({
    userSync: {
        iframeEnabled: true, // Enable iframe syncs (recommended)
        pixelEnabled: true,  // Enable pixel syncs
        filterSettings: {
            iframe: {
                bidders: ['mile'],
                filter: 'include'
            }
        }
    }
});
```

# Test Parameters

```javascript
var adUnits = [{
    code: 'test-banner',
    mediaTypes: {
        banner: {
            sizes: [[300, 250]]
        }
    },
    bids: [{
        bidder: 'mile',
        params: {
            placementId: 'test-placement-id'
        }
    }]
}];
```

