# Preset

Add, remove, rename, or list preset folders, and add or remove a
single preset within a folder, for a named or anonymous RadioTime
account. Must be called over HTTP/S.

## Summary

Adds or removes a single preset, adds or removes a preset folder, or lists preset folders, from a named or anonymous RadioTime account. This call should be made over HTTP/S to protect the identity information.

To browse presets, use the Browse Presets command.

Presets are covered more completely in the RadioTime concepts section of the developer’s guide. Anonymous accounts are explained here

### Input

| Parameter | Description |
| --- | --- |
| c | Set to `add`, `remove`, `addFolder`, `removeFolder`, `renameFolder`, or `listFolders` to indicate the preset action to take |
| partnerId | Required; identifies the partner making the call |
| username | Required if no deviceSerial; names the RadioTime account |
| password | Required if username specified |
| serial | Required if no username |
| folderId | Required for removeFolder or renameFolder, optional for add/remove; the guide ID of a specific preset folder in which to add or remove content, or the folder to remove or rename |
| id | Required for add/remove if no URL; set to the station, show, or url ID to add/remove as a preset |
| url | Required for add/remove if no ID; a string URL to save as a preset |
| name | Required for addFolder or renameFolder; the name to use for the folder |
| presetNumber | Optional; the position into which the preset should be saved |

### Output

On folder creation, an outline element with the folder’s guide ID will be returned. On `listFolders`, will give a set of text outline elements with the guide ID of each folder.

For all other actions, this call returns a simple status code. Check the response for fault details if not successful.

### Examples

In all of the following examples, you must send a valid **partnerId**, **username** and **password** or **serial**. Replace the values in <> with your actual identifiers.

```
# Adds the station KERA to a user's default preset folder
GET http://opml.radiotime.com/Preset.ashx?c=add&id=s32500&partnerId=<id>&username=<username>&password=<password>

# Adds the station KERA to a specific preset folder for an anonymous device account
GET http://opml.radiotime.com/Preset.ashx?c=add&id=s32500&folderId=f123456&partnerId=<id>&serial=<serial>

# Removes the show Fresh Air from a device account's default folder
GET http://opml.radiotime.com/Preset.ashx?c=remove&id=p17&partnerId=<id>&serial=<serial>

# Adds a new preset folder to a named account
GET http://opml.radiotime.com/Preset.ashx?c=addFolder&name=Rock+Stations&partnerId=<id>&username=<username>&password=<password>

# Lists all folders for a named account
GET http://opml.radiotime.com/Preset.ashx?c=listFolders&partnerId=<id>&username=<username>&password=<password>
```

### Notes

The Preset method is either a folder operation (addFolder, removeFolder, renameFolder) or an item operation (add/remove). All RadioTime accounts have a default folder which will be used in the absence of a specific folder ID.

To remove a preset URL, you will need to supply its guide ID. This is the value returned in the `guide_id` attribute of the outline element in the preset browse call.

Currently, it is only possible to add presets that have either station or show set as their `item` attribute.

If you overwrite a presetNumber, this action will shift the existing presets over. If you want to replace a preset, delete the existing preset in the occupied slot first.

If you set a new presetNumber for a station that is already in your presets, this action should assign the new presetNumber to the existing preset.

We describe the serial and username/account distinction more completely in the OPML security model section.

Station and show presets may not be immediately visible to users on radiotime.com due to data propagation times; these vary but should be no longer than a few minutes.

## See also

- [methods/browse.md § Browse Presets](browse.md#browse-presets) — read-only enumeration of presets and folders
- [methods/account.md](account.md) — joining a named account to a `serial` so the same presets follow the user across devices
- [elements/outline.md](../elements/outline.md) — `preset_id`, `preset_number`, and `is_preset` attributes
