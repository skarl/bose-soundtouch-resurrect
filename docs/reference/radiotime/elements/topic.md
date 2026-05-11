# topic

Metadata structure returned by the Describe method, containing
detailed information about a specific episode or airing of a radio
show.

## `<topic>` element

The topic element is a metadata structure returned by the Describe method. It contains detailed information about a specific episode or airing of a radio show.

### Attributes

None

### Child Elements

| Element | Description |
| --- | --- |
| title | The title of the topic |
| hosts | A comma-separated list of the show hosts associated with the topic |
| guide_id | The RadioTime unique identifier associated with the topic |
| description | The long description of the topic |
| url | The web address of the topic |
| logo | The full path to the logo for the show associated with the topic |
| is_available | Set to `true` or `false` to indicate if the media for this topic is supported by the requestor’s stream capability profile |
| stream_type | Set to `download`, `live`, or `ondemand` to indicate the kind media resource available for the topic. Live and ondemand are both streams; download indicates a downloadable audio file like an MP3 |
| media_type | The media type of the stream or file – value will correspond to one of the global formats, like `mp3`, `wma`, etc |
| show_id | The guide ID of the radio show to which this topic belongs |
| show_title | The title of the radio show to which this topic belongs |

### Examples

```xml
<topic>
  <guide_id>t31957842</guide_id>
  <title>Michael Savage 07/31/09 H3</title>
  <description>The Best of Savage. Savage asks listeners what they think of The New Yorker podcast, where they talked about Savage and his upcoming profile article in the magazine.</description>
  <hosts>Michael Savage</hosts>
  <url />
  <logo>http://radiotime-logos.s3.amazonaws.com/p20626.png</logo>
  <is_available>true</is_available>
  <stream_type>download</stream_type>
  <media_type>mp3</media_type>
  <show_id>p20626</show_id>
  <show_title>The Savage Nation</show_title>
</topic>
```

## See also

- [methods/describe.md § Describe Topic](../methods/describe.md#describe-topic) — the call that returns this element
- [elements/show.md](show.md) — parent metadata (a topic belongs to a show via `show_id` / `show_title`)
- [overview.md § Streams](../overview.md#streams) — `media_type` values correspond to the `formats` enumeration there
- [elements/outline.md](outline.md) — `type="object"` wrapper around `<topic>`
