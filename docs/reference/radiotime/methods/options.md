# Options

Context menu for a single item (right-click / "more options"
equivalent) — a list of actions and additional content available
for a station or show.

## Summary

This method offers a context menu (such as might be displayed on right click in a desktop application, or “more options” in a navigable device) for a specific item.

```
GET http://opml.radiotime.com/Options.ashx?id=s32500&partnerId=<id>&serial=<serial>
```

### Input

| Parameter | Value(s) | Required | Description |
| --- | --- | --- | --- |
| id | RadioTime ID | Yes | The guide ID of a single station or show |

### Output

A list of outline elements corresponding to actions and additional content available for the item. Currently this consists of a problem reporting wizard, a now playing display, recommendations, and stream selection.

## See also

- [methods/browse.md](browse.md) — primary navigation; Options is a follow-up call on an item discovered via Browse
- [methods/describe.md](describe.md) — non-navigable metadata alternative
- [elements/outline.md](../elements/outline.md) — the outline elements returned
