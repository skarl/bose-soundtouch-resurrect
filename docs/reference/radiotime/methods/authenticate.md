# Authenticate

GET-based credential verification for a RadioTime account.

## Summary

Allows a client to verify RadioTime account credentials.

> **Note.** The Account method ([account.md § Authenticate](account.md#authenticate))
> exposes the same verification through a POST endpoint with `c=auth`.
> Both endpoints are documented in the spec; the GET form here is
> typically used by simple clients, the POST form is preferred where
> credentials must not appear in URL logs.

### Input

```
GET https://opml.radiotime.com/Authenticate.ashx?partnerId=XYZ&username=u&password=p
```

| Parameter | Description |
| --- | --- |
| partnerId | Required; must be a valid RadioTime partner |
| username | The RadioTime account username |
| password | The plaintext account password |

### Output

On success, the `status` of the OPML response will be set to 200. If the credentials cannot be authenticated, a 401 status will result.

## See also

- [methods/account.md](account.md) — full account lifecycle including the alternative `c=auth` POST endpoint
- [elements/head.md](../elements/head.md) — `status` and `fault` / `fault_code` envelope returned on failure
