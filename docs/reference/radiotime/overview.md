# OPML overview

Global concepts that apply to every method in the API: request shape,
global parameters, headers, response envelope, stream format
enumeration, and the `filter=` syntax.

## Overview

OPML is nothing more than an outline representation of hierarchical data, the specification of which may be found here. Our implementation builds on the basic concepts to offer a full suite of radio directory services. Clients integrate these services with a simple, REST-style API.

The API consists of a few high-level methods – Browse, Describe, Search, etc – that can be traversed or invoked directly. Our usage guide describes these interaction models in more detail.

To do any meaningful work with the API, you will need to register a partner ID. Please see our getting started page for step-by-step instructions.

If developing a licensed implementation of the API, please comply with our certification checklist.

## Basics

An API request is nothing more than a URL with certain query string parameters. For example:

```
# Grab the root menu
GET http://opml.radiotime.com/Browse.ashx?partnerId=<id>&serial=<serial>

# Browse local radio (with IP geo-detection)
GET http://opml.radiotime.com/Browse.ashx?c=local&partnerId=<id>&serial=<serial>

# Browse the talk radio tree
GET http://opml.radiotime.com/Browse.ashx?c=talk&partnerId=<id>&serial=<serial>

# Tune into NPR's Fresh Air
GET http://opml.radiotime.com/Tune.ashx?c=pbrowse&id=p17&partnerId=<id>&serial=<serial>
```

Parameter values should be UTF-8 encoded and correctly URL-escaped.

### Parameters

Any request can specify one or more “global” parameters that affect the behavior of the service. They are:

| Parameter | Required | Purpose | Values |
| --- | --- | --- | --- |
| **partnerId** | Required for certification | Identifies your application as a client of the API. See the getting started guide for details | Provided on registration |
| **serial** | Required for certification | Identifies a client of the API from the perspective of the application they are using | See the security model for details |
| username | No | Identifies a specific TuneIn user as a client of the API. Allows access to presets and other account features and influences browse and tune behavior based on the user’s presets. It is best to Join and Drop a username to a serial. | Created by the user on http://TuneIn.com |
| formats | No | A comma-separated list of stream media types your application supports. Allows you to tailor the stations and shows that are filtered or displayed by their stream compatibility. E-mail development@tunein.com to set your partnerId formats automatically. | See the streaming section below.t |
| filter | No | A set of constraints for the content returned from a given search or browse | See the filter section below |
| locale | No | An ISO-639/ISO-3166 combination to override the HTTP Accept-Language header | en-US, es, etc |
| latlon | Strongly recommended if available | A specific latitude/longitude pair, comma separated, used to target local radio | 37.777228,-122.419281 |
| render | No | Changes the output rendering model | xml,json |
| callback | No | Used when the `render` parameter is set to `json` to specify a javascript function in which to enclose the JSON data | Your desired callback method name |

### Headers

The API does not require clients to set any special HTTP headers on requests. However, we recommend you set an appropriate User-Agent. Additionally, the following headers may be used to control service responses:

```
Accept-Language: de-de,de;q=0.5
```

Will, in the absence of a `locale` query parameter, change the language of content returned from any API method. Supported locales are returned by the describe locales method.

```
Accept-Encoding: gzip,deflate
```

Will, not surprisingly, give you a compressed response.

### Responses

An OPML response is either structured XML or JSON. XML documents will have `outline` elements and optional metadata. All response data will be UTF-8 encoded.

The root menu response, for example, looks like this:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<opml version="1">
    <head>
    <title>TuneIn</title>
    <status>200</status>
    </head>

    <body>
        <outline type="link" text="Local Radio" URL="http://opml.radiotime.com/Browse.ashx?c=local" key="local"/>
        <outline type="link" text="Music" URL="http://opml.radiotime.com/Browse.ashx?c=music" key="music"/>
        <outline type="link" text="Talk" URL="http://opml.radiotime.com/Browse.ashx?c=talk" key="talk"/>
        <outline type="link" text="Sports" URL="http://opml.radiotime.com/Browse.ashx?c=sports" key="sports"/>
        <outline type="link" text="By Location" URL="http://opml.radiotime.com/Browse.ashx?id=r0"/>
        <outline type="link" text="By Language" URL="http://opml.radiotime.com/Browse.ashx?c=lang" key="language"/>
        <outline type="link" text="Podcasts" URL="http://opml.radiotime.com/Browse.ashx?c=podcast" key="podcast"/>
    </body>
</opml>
```

## Streams

To control which stream types are returned by the API, specify the `formats` query string parameter. The following values are recognized:

| Format Value | Description |
| --- | --- |
| `wma` | WMAudio v8/9/10 |
| `mp3` | standard MP3 |
| `aac` | AAC and AAC+ |
| `real` | Real Media |
| `flash` | RTMP (usually MP3 or AAC encoded) |
| `html` | Usually desktop players |
| `wmpro` | Windows Media Professional |
| `wmvoice` | Windows Media Voice |
| `wmvideo` | Windows Media Video v8/9/10 |
| `ogg` | Ogg Vorbis |
| `qt` | Quicktime |

In the absence of a formats specification, the system uses a default of `wma,mp3`.

The streams delivered by Tune calls typically use a playlist. The playlist type is chosen based on the client (we can tailor to your capabilities) and the stream itself. By default we’ll serve a basic M3U.

In many cases our playlist will contain multiple streams, with the order chosen by factors including compatibility, reliability, and richness. In the event any stream in the playlist fails, your player should try the next in sequence.

See the aa2 query in order to test against different playlist/protocol/codec combinations.

Far more information on streaming may be found in our cookbook

## Filters

The `formats` parameter offers a specific kind of content filter – items available with the requested media types will be returned. The `filter` parameter allows you to exert similar control over many different item characteristics. You may notice that certain browse links returned by the service already populate a filter parameter. You can set it directly as needed.

The format of the filter parameter is a colon-delimited list of values:

```
filter=s:bit32*
```

The following filter values are understood by the service:

| Value | Description | Exclusive |
| --- | --- | --- |
| s | Limits the results only to stations | N |
| p | Limits the results only to shows | N |
| topic | Limits the results only to on-demand content | Y |
| video | Limits the results only to video content | Y |
| random | Limits the results to a single, random item from the complete set | N |
| bit32,bit64,bit128[*-] | Limits the results to a specific or range of bitrates | N |
| up-low,up-med,up-hi | Limits the results to stations with a reliability floor | N |

The bitrate filter allows you to specify the stations and shows returned as a function of their available streams. For example, on a mobile device, you may only want 32kbps and lower streams. The filter value for this is `bit32-` (note the minus at the end, indicating 32 and below). On the other hand, you may only want high quality streams, in which case you would request `bit128*`, indicating 128kbps and above. The only acceptable numeric values for the filter are 32, 64, and 128.

The reliability filter takes one of three values `up-low`, `up-med`, and `up-hi`. Reliability ratings reflect the general stability of the stream, across all listeners in the TuneIn system. Some streams are very stable and very reliable, while others come and go, or fluctuate throughout the day. By limiting to medium or high reliability stations, you can help influence a better playback experience. However, keep in mind that setting a reliability limit can **significantly** reduce selection, thus we recommend the user alter these settings via preferences.

Any filter value that is exclusive cannot be combined.

## Reserved Services

Some of the features in our API are enabled on a partner basis rather than by default. These are very clearly marked in our documentation.

Additionally, we are able to customize the behavior of the services in some areas on a partner basis. For example, we can change the default page sizes for category browse, the playlist types of tuning calls, and the level of detail in describe calls.

To request a reserved service, please contact development@tunein.com.

## See also

- [matrix.md](matrix.md) — how OPML compares to RadioTime's other APIs (OpenMedia, Widgets)
- [methods/browse.md](methods/browse.md) — first method to read; uses every global parameter
- [methods/describe.md](methods/describe.md) — non-navigable metadata lookup
- [elements/outline.md](elements/outline.md) — shape of the response payload
- [elements/opml.md](elements/opml.md), [elements/head.md](elements/head.md), [elements/body.md](elements/body.md) — response envelope
