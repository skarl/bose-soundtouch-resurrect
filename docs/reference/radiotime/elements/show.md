# show

Metadata structure returned by the Describe method, containing
detailed information about a broadcast radio show.

## `<show>` element

The show element is a metadata structure returned by the Describe method. It contains detailed information about a broadcast radio show.

### Attributes

None

### Child Elements

| Element | Description |
| --- | --- |
| title | The name of the show |
| hosts | A comma-separated list of the show hosts |
| guide_id | The RadioTime unique identifier associated with the show |
| preset_id | The RadioTime unique identifier to be used to store the show as a preset |
| is_preset | Whether the show is already a preset (only available if a username is passed to the call) |
| description | The long description of the show |
| url | The web address of the show |
| detail_url | The web address of the RadioTime details page for this show |
| report_url | A web address with a contact form to report problems with the show |
| twitter_id | The twitter accounts associated with the show (comma separated if more than one) |
| logo | The full path to the logo for the show |
| location | The central broadcast location for the show |
| has_topics | A flag indicating if RadioTime has topic coverage for this show |

### Examples

```xml
<show>
  <title>Fresh Air (NPR)</title>
  <hosts>Terry Gross</hosts>
  <guide_id>p17</guide_id>
  <preset_id>p17</preset_id>
  <description>Fresh Air opens the window on contemporary arts and issues...</description>
  <is_preset>false</is_preset>
  <url>http://freshair.npr.org/</url>
  <report_url>http://radiotime.com/FeedbackRedir.aspx?programId=17</report_url>
  <twitter_id />
  <logo>http://radiotime-logos.s3.amazonaws.com/p17.png</logo>
  <location>Philadelphia, PA</location>
</show>
```

## See also

- [methods/describe.md § Describe Show](../methods/describe.md#describe-show) — the call that returns this element
- [elements/topic.md](topic.md) — metadata for a single episode of a show (`has_topics` here indicates whether topics exist)
- [elements/station.md](station.md) — sibling metadata body
- [elements/outline.md](outline.md) — `type="object"` wrapper around `<show>`
