# Browse

Navigation and audio content from the RadioTime radio directory.
Covers presets, popular channels, locations, station details, show
details, schedules, and playlists, distinguished by an input *browse
classifier* (`c=`).

## Summary

The browse method produces navigation and audio content from our radio directory. It covers several different structures – presets, popular channels, locations – that are distinguished by an input *browse classifier*.

All versions of the Browse method accept (and in some cases require) the global variables for OPML.

Be sure to glance at our browse solution for general considerations.

## Browse Index

When invoked without a classifier, the browse method returns a list of the available navigation structures. We strongly recommend you use this index as a “launch” point and follow the navigation links provided, rather than deep linking to an internal browse URL.

### Input

```
GET http://opml.radiotime.com/Browse.ashx?partnerId=<id>&serial=<serial>
```

### Output

```xml
<opml version="1">
<head>
    <title>RadioTime</title>
    <status>200</status>
</head>
<body>
    <outline type="link" text="Local Radio" URL="http://opml.radiotime.com/Browse.ashx?c=local" key="local"/>
    <outline type="link" text="Talk" URL="http://opml.radiotime.com/Browse.ashx?c=talk" key="talk"/>
    <outline type="link" text="Sports" URL="http://opml.radiotime.com/Browse.ashx?c=sports" key="sports"/>
    <outline type="link" text="Music" URL="http://opml.radiotime.com/Browse.ashx?c=music" key="music"/>
    <outline type="link" text="By Location" URL="http://opml.radiotime.com/Browse.ashx?id=r0"/>
    <outline type="link" text="By Language" URL="http://opml.radiotime.com/Browse.ashx?c=lang" key="language"/>
    <outline type="link" text="Podcasts" URL="http://opml.radiotime.com/Browse.ashx?c=podcast" key="podcast"/>
</body>
</opml>
```

## Browse Local

Creates a list of radio stations local to the caller, typically using IP geo-location.

### Input

```
GET http://opml.radiotime.com/Browse.ashx?c=local&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| c | Set to `local` for this call |
| username | When provided, stations are based on the location defined by the account. Account location settings are managed on radiotime.com |
| latlon | When provided, stations are based on proximity to the geo-coordinate. If the coordinate is in the US, results will be similar to a zipcode search |
| formats | A comma-separated list of compatible stream formats. See the overview for more details. Hardware tuners can also use “am”, “fm”, or “hd” |

Neither the username nor the latlon parameters are necessary; when they are not given, the system will use the incoming IP address to provide results.

### Output

A complete list of outline elements for stations in the discovered location. If the location maps to an area with sub-locations (like a country), the child elements will be links to those sub-locations.

### Notes

If your application proxies client calls, you must forward the originating address in an HTTP header labeled “X-Forwarded-For”. See the local considerations for more detail.

The `latlon` parameter has precedence over any others; if specified, it will be used ahead of any user-associated region or IP detection.

Very few video streams are mapped to local regions; if you are browsing only for video, the response may not contain any channels.

## Browse Presets

Either a valid RadioTime username or an authorized serial number is required. The service will offer either a list of items (if there is a single preset folder), or a list of folders. Please see the Preset API method for more information on managing presets.

### Input

```
# Gets presets for a named account
GET http://opml.radiotime.com/Browse.ashx?c=presets&partnerId=<id>&username=<username>

# Gets presets for an anonymous device account
GET http://opml.radiotime.com/Browse.ashx?c=presets&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| c | Set to `presets` for this call |
| partnerId | **Required** for this call |
| username | Required if no serial; set to the account whose presets you wish to browse |
| serial | Required if no userName; maps a unique client to an anonymous RadioTime account |
| formats | A comma-separated list of compatible stream formats. See the overview for more details |

### Output

If the account has a single preset folder, results will be returned directly. Otherwise, you will receive navigable links for each folder.

### Notes

While presets are available by default, this call **requires** a valid partner ID – it cannot be invoked anonymously.

A user may set a radio preset on RadioTime.com (or another device) that is not playable on your device. If this occurs, they will see the text “not supported” on your device’s presets.

## Browse Categories

We organize our content into a few broad divisions. They are returned as part of the index menu but may also be addressed directly. For example:

```
# Fetch the talk radio menu
GET http://opml.radiotime.com/Browse.ashx?c=talk&partnerId=<id>&serial=<serial>
```

### Input

The following values are valid for the input parameter `c`:

| Category | URL |
| --- | --- |
| Music | http://opml.radiotime.com/Browse.ashx?c=music&partnerId=<id>&serial=<serial> |
| Talk | http://opml.radiotime.com/Browse.ashx?c=talk&partnerId=<id>&serial=<serial> |
| Sports | http://opml.radiotime.com/Browse.ashx?c=sports&partnerId=<id>&serial=<serial> |
| World | http://opml.radiotime.com/Browse.ashx?c=world&partnerId=<id>&serial=<serial> |
| Podcasts | http://opml.radiotime.com/Browse.ashx?c=podcast&partnerId=<id>&serial=<serial> |
| Popular | http://opml.radiotime.com/Browse.ashx?c=popular&partnerId=<id>&serial=<serial> |
| Best | http://opml.radiotime.com/Browse.ashx?c=best&partnerId=<id>&serial=<serial> |

The world channel is appropriate for finding a specific location by navigating countries, states, and cities. The popular channel produces a smart list of available stations relevant to your language and country. The podcast channel essentially traverses our genres, but displays only programs with on-demand or podcast content.

Please keep in mind that all the global parameters apply to this call. The filter parameter can dramatically change the nature of results returned when browsing a category. For example, you can build a “jukebox” feature by setting a filter of `random`:

```
# Fetch a random available Electronic music station 
GET http://opml.radiotime.com/Browse.ashx?id=c57941&filter=s:random&partnerId=<id>&serial=<serial>
```

For the full set of supported filter tokens, see
[overview.md § Filters](../overview.md#filters).

### Output

Navigable sub-categories for the given category

### Notes

The links returned by this method are themselves deeper-level category browsing calls, which will contain groups of stations and shows. By default we return configured page sizes of results in these groups (10 for shows, 50 for stations). This may be customized.

## Browse Language

RadioTime offers radio content from around the world, which means we tag stations and shows in hundreds of languages. The browse language option offers an easy way to filter to a specific language.

### Input

```
# Fetch the root language menu
GET http://opml.radiotime.com/Browse.ashx?c=lang&partnerId=<id>&serial=<serial>

# Fetch a genre only for Spanish
GET http://opml.radiotime.com/Browse.ashx?c=lang&filter=l99&partnerId=<id>&serial=<serial>
```

### Output

Without the `filter` parameter, the service will return a list of languages available in the guide. From that point forward the experience is like a regular category browse, with content narrowed to stations and shows matching the language.

## Browse a Station

We maintain station recommendations for many of the stations in our guide. This method makes it possible to browse this content.

### Input

```
GET http://opml.radiotime.com/Browse.ashx?id=s32500&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| id | Set to the guide ID of the station |
| detail | May be set to `affiliate`, `genre`, `recommendation`, or a combination of these three separated by commas (like “affiliate,genre”). When set, the service will return only the specified groups of content |

There is no classifier needed for this call.

### Output

If no `detail` parameter is provided, a list of stations similar to the given station, plus links for the station’s genre and affiliates. Otherwise, the specific requested groups of content.

## Browse Station Schedules

For those stations for which we maintain show schedules, you may browse a complete list for the current day or a specified date range.

### Input

```
GET http://opml.radiotime.com/Browse.ashx?c=schedule&id=s32500&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| c | Set to `schedule` for this call |
| id | Set to the guide ID of the station |
| username | A RadioTime account name; will affect the time zone of the response lineup |
| start | The start date for the lineup, in form `yyyymmdd` |
| stop | The end date for the lineup, in form `yyyymmdd` |
| forward | When set to `true`, the service will ignore the start and stop dates and instead provide a schedule looking forward over the next 24-36 hours. Also see the `live` parameter |
| live | When using the `forward` parameter, setting `live` to true will include the currently live show in the result. Otherwise the service will return the lineup starting with the show next on. |
| offset | The number of minutes the client timezone is offset from UTC |
| autodetect | When set to `true`, the service will attempt to determine the client timezone |

To retrieve a specific day, you may omit the stop date. The service currently limits each request to a maximum of 3 days.

### Output

A list of shows in chronological order, with start times in the user time zone (if a username is supplied), the timezone offset from UTC (is the offset parameter is supplied), or UTC. Each show will have an outline element like the following:

```xml
<outline type="link" text="Science in Action" URL="http://opml.radiotime.com/Browse.ashx?c=topics&id=p440&title=Science+in+Action" guide_id="p440" start="2009-03-16T00:06:00" duration="1440" image="http://radiotime-logos.s3.amazonaws.com/p440q.png" tz="Central"/>
```

The duration attribute is in seconds. The URL may be used to tune the show if it is currently broadcasting, or if it has previous topics available for listening. The tz attribute gives the descriptive name of the user time zone, if a username or offset is supplied.

## Browse Station Playlist

For those stations for which we maintain song coverage, you may browse a list of songs played for the current day or a specified date range.

### Input

```
GET http://opml.radiotime.com/Browse.ashx?c=playlist&id=s32500&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| c | Set to `playlist` for this call |
| id | Set to the guide ID of the station |
| username | A RadioTime account name; will affect the time zone of the response lineup |
| start | The start date for the playlist, in form `yyyymmdd`. If not specified, the default is the current day |
| stop | The end date for the playlist, in form `yyyymmdd` |

To retrieve a specific day, you may omit the stop date. The service currently limits each request to a maximum of 3 days.

### Output

A list of songs in chronological order, with start times in the detected time zone (account timezone if a username is supplied, otherwise the timezone from IP detection), and text and subtext set to the song title and artist, respectively.

```xml
<outline type="link" text="Tighten Up" URL="http://opml.radiotime.com/Browse.ashx?id=m179923" guide_id="m179923" subtext="The Black Keys" start="2010-07-20T17:37:40" tz="Central"/>
```

The outline elements are given as a link to browse content for the artist. The tz attribute gives the descriptive name of the time zone for which the start time applies.

## Browse a Show

This method offers browsing to related affiliate networks and genres for a given radio show.

### Input

```
GET http://opml.radiotime.com/Browse.ashx?id=p17&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| id | Set to the guide ID of the radio show |

There is no classifier needed for this call.

### Output

By default this method returns applicable genres and affiliate networks associated with the show.

## See also

- [overview.md](../overview.md) — global parameters, filter syntax, format enumeration
- [methods/describe.md](describe.md) — non-navigable metadata lookup for items reached via Browse
- [methods/preset.md](preset.md) — managing the presets that `c=presets` browses
- [methods/options.md](options.md) — context menus for an item reached via Browse
- [elements/outline.md](../elements/outline.md) — shape of every element in a Browse response
- [elements/station.md](../elements/station.md), [elements/show.md](../elements/show.md) — metadata bodies referenced by station/show browses
