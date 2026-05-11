# Describe

Non-navigable metadata for a single item or a reference list. Used
to render richer detail screens after Browse has reached a station,
show, or topic, and to enumerate the supported countries, languages,
locales, formats, and genres.

## Summary

The Describe method offers detailed information about an item in the radio directory in a non-navigable form. This may be useful in constructing a richer user interface after an audio item such as a station or show is reached in navigation.

Callers may request alternate metadata by specifying the query string parameter `c`. The following metadata are currently available:

## Describe NowPlaying

This method returns 2 or more text lines describing the content currently broadcast on a station or stream. The service does not support frequent or long polling to enable client-side display refresh. Please look for and use the cache-control HTTP response header to determine when to make the next call.

```
Cache-Control: private, max-age=5964
```

Indicates you should wait about 100 minutes before the next request.

### Input

```
GET http://opml.radiotime.com/Describe.ashx?c=nowplaying&id=s32500&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| c | Set to `nowplaying` for this call |
| id | Set to the guide ID for which you need information; you can gather this from any previous outline element’s `guide_id` attribute |

### Output

Currently we provide a descriptive station name, show title, and show genre for scheduled programming:

```xml
<opml version="1">
<head>
    <status>200</status>
</head>
<body>
    <outline type="text" text="KERA 90.1" image="http://radiotime-logos.s3.amazonaws.com/p38386q.png" preset_id="s32500"/>
    <outline type="text" text="Day to Day"/>
    <outline type="text" text="Magazine"/>
</body>
</opml>
```

### Notes

If the station has song coverage in our guide, one of the text elements will be the name and artist associated with the song.

## Describe Station

Given only a station ID, the service will return detailed information about the corresponding station. The types of detail may be specified as input.

### Input

```
# Fetch basic metadata for the station
GET http://opml.radiotime.com/Describe.ashx?id=s32500&partnerId=<id>&serial=<serial>

# Fetch basic metadata, genres, and recommendations
GET http://opml.radiotime.com/Describe.ashx?id=s32500&detail=genre,recommendation&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| id | Set to the guide ID for which you need information; you can gather this from any previous outline element’s `guide_id` attribute |
| detail | A comma-separated list of values indicating additional detail to retrieve. The allowable options are `affiliate`, `genre`, and `recommendation`, or a comma-separated combination of the three. This parameter is not required |

### Output

Will return a single outline element of type `object`, containing a station. If the `detail` parameter is specified, the response will also contain the requested groups.

## Describe Show

Given only a show ID, the service will return detailed information about the corresponding show.

### Input

```
# Fetch basic metadata for the show
GET http://opml.radiotime.com/Describe.ashx?id=p17&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| id | Set to the guide ID for which you need information; you can gather this from any previous outline element’s `guide_id` attribute |
| detail | A comma-separated list of values indicating additional detail to retrieve. The allowable options are `affiliate`, `genre`, and `recommendation`, or a comma-separated combination of the three. This parameter is not required |

### Output

Will return a single outline element of type `object`, containing a show. If the `detail` parameter is specified, the response will also contain the requested groups.

## Describe Topic

Retrieves metadata for a single radio show topic.

### Input

```
# Fetch basic metadata for a topic
GET http://opml.radiotime.com/Describe.ashx?id=t33665899&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| id | Set to the guide ID for which you need information; you can gather this from a previous outline element’s `guide_id` attribute |

### Output

Will return a single outline element of type `object`, containing a topic.

## Describe Countries

Retrieves a list of all countries known to the RadioTime directory.

### Input

```
# Fetch all countries
GET http://opml.radiotime.com/Describe.ashx?c=countries&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| c | Set to `countries` for this call |

### Output

A list of outline elements whose `guide_id` attributes may be used in Search, Browse, and Account calls.

## Describe Languages

Retrieves a list of all languages broadcast by stations in the RadioTime directory. This is **not** the same as the languages in which we have content translated. For that, see the locales list below.

### Input

```
# Fetch all languages
GET http://opml.radiotime.com/Describe.ashx?c=languages&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| c | Set to `languages` for this call |

### Output

A list of outline elements whose `guide_id` attributes may be used as a language filter in Search and Browse calls. The language names will be localized based on the request.

## Describe Locales

Retrieves a list of all locales supported by the API. These are values appropriate for use with the `locale` query string parameter or the HTTP `Accept-Language` header.

### Input

```
# Fetch all locales
GET http://opml.radiotime.com/Describe.ashx?c=locales&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| c | Set to `locales` for this call |

### Output

The complete list of supported service locales. Look to the `guide_id` attribute for correct values.

## Describe Formats

Retrieves a list of the media formats recognized by the API. These are values appropriate for use with the `formats` query string parameter.

### Input

```
# Fetch all formats
GET http://opml.radiotime.com/Describe.ashx?c=formats&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| c | Set to `formats` for this call |

### Output

The complete list of supported service formats. Look to the `guide_id` attribute for correct values.

For the format value enumeration documented in the spec itself, see
[overview.md § Streams](../overview.md#streams).

## Describe Genres

Retrieves a list of all genres tagged in the RadioTime directory.

### Input

```
# Fetch all genres
GET http://opml.radiotime.com/Describe.ashx?c=genres&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| c | Set to `genres` for this call |

### Output

A list of outline elements whose `guide_id` attributes may be used in Search, Browse, and Account calls. The genre name will be localized based on the request.

## See also

- [overview.md](../overview.md) — global parameters and `locale` / `formats` reference
- [methods/browse.md](browse.md) — how to discover IDs to pass to Describe
- [elements/station.md](../elements/station.md), [elements/show.md](../elements/show.md), [elements/topic.md](../elements/topic.md) — shape of the `object`-typed outline returned for each item kind
- [elements/outline.md](../elements/outline.md) — wrapping outline element
