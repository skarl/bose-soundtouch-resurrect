# head

Metadata envelope present in every OPML response — status code,
optional fault description, document title, and expansion state.

## `<head>` element

The head element is present in every OPML response. It contains a number of sub-elements that describe characteristics of the returned data.

### Attributes

None

### Child Elements

| Element | Description |
| --- | --- |
| status | The default RadioTime status of the call. We mirror HTTP status codes – 200, 400, 500, etc |
| fault | A description of any error that occurred in processing. Will typically be set when the status is not 200 |
| fault_code | A key associated with the fault. While the fault text may change over time, the codes will remain constant, allowing clients to react to them consistently. |
| title | The name of OPML document returned |
| expansionState | A comma-separated list of outline indexes that are expanded in the document |

### Examples

A typical successful response:

```xml
<head>
    <status>200</status>
    <title>Search results: kera</title>
</head>
```

A failed client response:

```xml
<head>
    <status>400</status>
    <fault>Required parameter 'feedback' not provided</fault>
    <fault_code>validation.feedback</fault_code>
</head>
```

## See also

- [elements/opml.md](opml.md) — the root element containing `<head>`
- [elements/body.md](body.md) — the sibling element carrying the payload
- [methods/account.md § Create](../methods/account.md#create) — example list of `fault_code` values returned in this envelope
