# Config

Server-time / timezone detection, localized string resources, and
stream-sample retrieval for client development and testing.

## Summary

Offers several client and server side configuration services.

## Time

Retrieves the current server time and details of the client detected timezone. Client timezone detection is based on IP geolocation, unless a latlon parameter is specified or a RadioTime account name is passed.

### Input

```
GET https://opml.radiotime.com/Config.ashx?c=time&partnerId=<id>
```

| Parameter | Description |
| --- | --- |
| c | Set to `time` for this call |

### Output

A single outline element with the following attributes:

| Attribute | Description |
| --- | --- |
| utc_time | The current time in UTC, expressed as seconds since the epoch (Unix time format) |
| server_time | The current time in the RadioTime server’s time zone, as seconds since the epoch |
| server_tz | The name of the RadioTime server’s time zone |
| server_offset | The offset, in minutes, of the server’s time zone from UTC |
| detected_time | The current time in the detected time zone of the client, as seconds since the epoch |
| detected_tz | The name of the detected time zone |
| detected_offset | The offset, in minutes, of the detected time zone from UTC |

```xml
<outline text="time" utc_time="1265925455" server_time="1265903855" server_tz="Central" server_offset="-360" detected_time="1265903855" detected_tz="Central" detected_offset="-360"/>
```

## Localized Strings

This is a reserved service that allows an application to retrieve text resources in a particular locale.

### Input

```
GET https://opml.radiotime.com/Config.ashx?c=contentQuery&partnerId=<id>
```

| Parameter | Description |
| --- | --- |
| c | Set to `contentQuery` for this call |

Clients should set the `locale` parameter or the HTTP `Accept-Language` header to the desired translation locale.

### Output

A series of text elements containing localized resources.

| Attribute | Description |
| --- | --- |
| key | The name of the resource |
| value | The localized value of the resource |

```xml
<outline text="content" key="settings" value="Settings"/>
<outline text="content" key="connecting" value="Connecting..."/>
```

## Stream Sample

Retrieves a list of streams using the various protocols, playlists, and codecs for player development and testing.

### Input

```
GET https://opml.radiotime.com/Config.ashx?c=streamSampleQuery&partnerId=<id>
```

| Parameter | Description |
| --- | --- |
| c | Set to `streamSampleQuery` for this call |

### Output

A series of audio elements containing an example stream.

```xml
<outline type="audio" text="Managed: MP3|HTTP|M3U" URL="http://www.motor.de/extern/motorfm/stream/motorfm.mp3"/>
<outline type="audio" text="Managed: AAC|ICY|M3U" URL="http://etn.fm/playlists/etn2-aac-high.m3u"/>
```

## See also

- [overview.md § Streams](../overview.md#streams) — full enumeration of `formats` values referenced by the stream sample output
- [overview.md § Headers](../overview.md#headers) — `Accept-Language` and `locale` parameter for the Localized Strings call
- [elements/outline.md](../elements/outline.md) — shape of every returned element
