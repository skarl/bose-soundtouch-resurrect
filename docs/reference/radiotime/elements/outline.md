# outline

The primary data structure returned by every OPML API method —
each navigation link, audio link, text line, and metadata object
in a response is an `<outline>` element with attributes describing
its kind and payload.

## `<outline>` element

The outline element is the primary data structure returned by OPML API methods. It contains a variety of attributes that may or may not be populated on a given call.

By specification, outline elements will always have a `text` attribute, set with the label for the container.

### Outline Types

Most outline elements will carry a `type` attribute, identifying the resource contained or referenced. An outline without a type is either a container or a text item.

| Outline Type | Description |
| --- | --- |
| link | A link to another OPML document, representing the next level in the tree |
| text | A message to be displayed |
| audio | A link to a stream resource |
| object | A wrapper for a metadata object, such as a station or show. Applies to the Describe method |
| search | The canonical search URL that is available from the service |

### Outline Attributes

| Attribute | Outline Type | Description |
| --- | --- | --- |
| text | text, link, audio | A textual description of the element, intended for display |
| URL | link, audio | The web URL for additional navigation content or streaming audio |
| guide_id | text, link, audio | A globally unique identifier for the element in the RadioTime directory, which may be passed to a Describe call for more detailed information |
| subtext | text, link, audio | A textual sub-description of the element, intended for display. The service applies an intelligent rule to select an appropriate identifier, such as the song now playing, the current show, the station slogan, or the broadcast language |
| key | text, link | A unique string that identifies an element in a consistent way. While text strings may be localized, key values will not. Clients may use the key to take specific action based on the presence or absence of an element |
| bitrate | audio | The applicable bitrate for the stream. If more than one stream qualifies, this will reflect the highest value among them |
| reliability | audio | The applicable reliability rating of the stream. If more than one stream qualifies, this will reflect the highest value among them |
| image | link, audio | A URL for a logo or icon suited to the element. These will generally be 145×145 pixels in PNG format |
| current_track | link, audio | A short text label for “now playing” information on a radio station, often the short name of a show |
| playing | link, audio | A formatted version of the song now playing on a radio station, including the artist and title |
| media_type | audio | The applicable stream media type – such as ”mp3”,”real”, etc |
| preset_id | link, audio | Deprecated – use guide_id instead. A globally unique identifier that may be passed to the Preset API method |
| now_playing_id | link, audio | Deprecated – use guide_id instead. A globally unique identifier that may be passed to the Describe method for detailed “now playing” information. |
| preset_number | link, audio | The preset sort position of this element. Only applicable on preset browse |
| is_preset | link, audio | Whether the element is in the user’s presets |

### Child Elements

Any text or link outline element can act as a container:

```xml
<outline text="Featured Stations (1)">
    <outline URL="http://opml.radiotime.com/Tune.ashx?id=s32429" text="Play 128kbps MP3"
    bitrate="128" image="http://radiotime-logos.s3.amazonaws.com/s32429q.png"
    current_track="Local Frequency"
    now_playing_id="s32429" preset_id="s32429" />
</outline>
```

This should render as a menu option named “Featured Stations (1)”, with a submenu containing the name of the station.

### Keys

The following key values may be found in various OPML calls:

| Key Value | Method |
| --- | --- |
| stations | Browse any category with stations, identifies the container with live stations |
| stations | Tune radio show, identifies the container with stations playing the show |
| shows | Browse any category with shows; identifies the container with live shows |
| topics | Tune radio show, identifies the container with topics |
| related | Browse any category; identifies the container with links to related categories |
| local | Browse any category; identifies the container with live local stations |
| pivot | Browse any region; identifies the container with pivots to genre, name, etc |
| pivotLocation | Browse any genre; identifies the link that pivots to location |
| popular | Browse any category; identifies the link to popular stations in the category |

## See also

- [elements/opml.md](opml.md), [elements/head.md](head.md), [elements/body.md](body.md) — the response envelope containing outline elements
- [elements/station.md](station.md), [elements/show.md](show.md), [elements/topic.md](topic.md) — the metadata bodies wrapped by `type="object"` outlines from Describe
- [methods/browse.md](../methods/browse.md), [methods/describe.md](../methods/describe.md) — the two methods that produce most outline elements
- [overview.md § Filters](../overview.md#filters) — `bitrate` and `reliability` attribute values map to the `filter=` tokens documented there
