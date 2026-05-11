# station

Metadata structure returned by the Describe method, containing
detailed information about a single radio station.

## `<station>` element

The station element is a metadata structure returned by the Describe method. It contains detailed information about a radio station.

### Attributes

None

### Child Elements

| Element | Description |
| --- | --- |
| name | The name of the station |
| call_sign | The call sign associated with the station (terrestrial radio only, for the most part) |
| slogan | The slogan of the station |
| frequency | The frequency associated with the station (terrestrial radio only) |
| band | The broadcast band associated with the station (terrestrial radio only) |
| guide_id | The RadioTime unique identifier associated with the station |
| preset_id | The RadioTime unique identifier to be used to store the station as a preset |
| is_preset | Whether the show is already a preset (only available if a username is passed to the call) |
| description | The long description of the station |
| url | The web address of the station |
| detail_url | The web address of the RadioTime details page for this station |
| report_url | A web address with a contact form to report problems with the station |
| twitter_id | The twitter accounts associated with the station (comma separated if more than one) |
| logo | The full path to the logo for the station |
| location | The central broadcast location for the station |
| is_available | Whether the station has a tunable stream based on the current media filter |
| has_song | Whether the station’s song is currently tracked |
| has_schedule | Whether the show lineup is available for this station in the guide |
| current_song | The name of the now playing song (only if known) |
| current_artist | The artist associated with the now playing song (only if known) |
| current_album | The album associated with the now playing song (only if known) |
| language | The name of the language in which this station broadcasts (will be localized) |
| email | The contact email address of this station |
| mailing_address | The physical address of this station |
| phone | The contact phone number of this station |
| genre_id | The RadioTime unique identifier of the primary genre associated with the station |
| genre_name | The localized name of the primary genre |
| region_id | The RadioTime unique identifier of the primary region in which this station resides |

### Examples

```xml
<station>
<guide_id>s32500</guide_id>
<preset_id>s32500</preset_id>
<name>KERA</name>
<call_sign>KERA</call_sign>
<slogan/>
<frequency>90.1</frequency>
<band>FM</band>
<url>http://www.kera.org/radio/</url>
<report_url>

http://radiotime.com/FeedbackRedir.aspx?stationId=32500

</report_url>
<detail_url>

http://radiotime.com/StationDetails.aspx?stationId=32500

</detail_url>
<is_preset>false</is_preset>
<is_available>true</is_available>
<has_song>false</has_song>
<has_schedule>true</has_schedule>
<twitter_id>keratx</twitter_id>
<logo>

http://radiotime-logos.s3.amazonaws.com/s32500q.png

</logo>
<location>Dallas-Fort Worth, TX</location>
<description/>
<email/>
<phone>214-871-1390</phone>
<mailing_address>3000 Harry Hines Boulevard, Dallas, Texas 75201</mailing_address>
<language>English</language>
<genre_id>g266</genre_id>
<genre_name>Public</genre_name>
<region_id>r100005</region_id>
</station>
```

## See also

- [methods/describe.md § Describe Station](../methods/describe.md#describe-station) — the call that returns this element
- [elements/show.md](show.md), [elements/topic.md](topic.md) — sibling metadata bodies for other item kinds
- [elements/outline.md](outline.md) — `type="object"` wrapper around `<station>`
