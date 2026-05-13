# Account

Create, authenticate, join, drop, query, remind, reset, and claim a
TuneIn account. All calls must be made over HTTP/S; parameters
should be POSTed rather than placed in the query string.

## Summary

Allows clients to create or work with TuneIn accounts. The action to take is specified by the `c` command parameter.

All calls to account methods must be made over HTTP/S. We strongly recommend all parameters be POSTed to the service rather than specified in a query string.

Any account operation involving serial numbers (i.e., anonymous accounts) falls under our reserved services. Please contact development@development.com to enable the services for your application.

## Authenticate

Verifies credentials associated with a TuneIn account.

> **Note.** A second authentication endpoint exists at
> `Authenticate.ashx` (GET-style). It accepts the same credentials
> with no `c=` classifier and is documented separately in
> [authenticate.md](authenticate.md). The two endpoints have
> overlapping function but distinct URLs and HTTP methods; the spec
> documents both without reconciling them.

### Input

```
POST https://opml.radiotime.com/Account.ashx
c=auth&partnerId=<id>&username=u&password=p
```

| Parameter | Description |
| --- | --- |
| c | Set to `auth` for this call |
| partnerId | Required; must be a valid TuneIn partner |
| username | The TuneIn account username |
| password | The plaintext account password |

### Output

On success, the `status` of the OPML response will be set to 200. If the credentials cannot be authenticated, a 401 status will result.

## Create

Creates a new TuneIn named account, optionally associating with a device if the `serial` parameter is provided.

### Input

```
# Create account for user in California
POST https://opml.radiotime.com/Account.ashx
c=create&partnerId=XYZ&username=u&password=p&email=e@mail.com&postalCode=90210

# Create account for user in London
POST https://opml.radiotime.com/Account.ashx
c=create&partnerId=XYZ&username=u&password=p&email=e@mail.com&city=London&countryId=n100
```

| Parameter | Description |
| --- | --- |
| c | Set to `create` for this call |
| partnerId | Required; must be a valid TuneIn partner |
| username | The TuneIn account username to create. Must be 12 alpahnumeric characters or less |
| password | The plaintext account password. Must be between 4 and 12 alphanumeric or symbol characters |
| email | Required; the email address for the account. |
| postalCode | If the user is in the US or Canada, the postal code of the user’s location. Required if no city/country |
| city | If no postalCode, the city of the user’s location. Required if no postal code |
| countryId | The TuneIn-specific country ID of the user’s location. These codes may be retrieved from the describe countries method |
| serial | Optional; the device serial key that may reference an existing anonymous account |

### Output

On success, the `status` of the OPML response will be set to 200. On failure, look for the `fault` and `fault_code` elements in the header. The following codes may be set:

| Fault Code | Description |
| --- | --- |
| validation.email | The given email address is of invalid form (empty or incorrect) |
| validation.password | The given password is of invalid form (empty or incorrect) |
| validation.location | The given postalCode or city/country combination is invalid |
| validation.userNameExists | The requested account name is already taken |
| validation.emailExists | The requested email is already registered |
| validation.error | A validation error occurred |

## Join

Associates a named TuneIn account with an existing device. If the user has created presets under an anonymous account, they will be merged with the named account.

### Input

```
POST https://opml.radiotime.com/Account.ashx
c=join&partnerId=<id>&username=u&password=p&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| c | Set to `join` for this call |
| partnerId | Required; must be a valid TuneIn partner |
| username | The TuneIn account username |
| password | The plaintext account password |
| serial | The serial key of the device to associate |

### Output

On success, the `status` of the OPML response will be set to 200. If the account is already associated with a device, the `fault_code` will be set to `validation.deviceExists`.

## Drop

Removes a device from a named account. This will reset any presets associated with the device.

### Input

```
POST https://opml.radiotime.com/Account.ashx
c=drop&partnerId=<id>&username=u&password=p&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| c | Set to `drop` for this call |
| partnerId | Required; must be a valid TuneIn partner |
| username | The TuneIn account username |
| password | The plaintext account password |
| serial | The unique serial key associated with the device to remove |

### Output

On success, the `status` of the OPML response will be set to 200. If the device is not associated with the account, the `fault_code` element will be set to `validation.deviceNotAssociated`

## Query

Returns the TuneIn account name associated with a given serial value. Useful to determine if a particular account is already joined.

### Input

```
POST https://opml.radiotime.com/Account.ashx
c=query&partnerId=<id>&serial=<serial>
```

### Output

On success, a single outline element will be returned, whose `text` attribute is set to the name of the associated TuneIn account. If there is no such account, a fault code of `validation.deviceNotAssociated` will be returned.

## Remind

Sends an account reminder to a registered email address

### Input

```
POST https://opml.radiotime.com/Account.ashx
c=remind&partnerId=<id>&email=<email>
```

| Parameter | Description |
| --- | --- |
| c | Set to `remind` for this call |
| partnerId | Required; must be a valid TuneIn partner |
| email | An email address associated with a TuneIn account |

### Output

On success, the `status` of the OPML response will be set to 200 and a text email will be sent to the address with details about the TuneIn account name. If the email is not associated with an account, a 400 status will result.

## Reset

Provides an opportunity for a user to reset his/her account password

### Input

```
POST https://opml.radiotime.com/Account.ashx
c=reset&partnerId=<id>&username=<username>&email=<email>
```

| Parameter | Description |
| --- | --- |
| c | Set to `reset` for this call |
| partnerId | Required; must be a valid TuneIn partner |
| username | The account username to reset; not required if email supplied |
| email | An email address associated with a TuneIn account; not required if username supplied |

### Output

On success, the `status` of the OPML response will be set to 200 and a text email will be sent to the address with instructions how to reset the account. If the username or email is not valid, a 400 status will result.

## Claim

Generates a simple keyphrase that a user can enter on the TuneIn.com/mydevice page to associate a device with an anonymous account.

### Input

```
POST https://opml.radiotime.com/Account.ashx
c=claim&partnerId=<id>&serial=<serial>
```

| Parameter | Description |
| --- | --- |
| c | Set to `claim` for this call |
| partnerId | Required; must be a valid TuneIn partner |
| serial | The unique ID of the device to be associated with an account |

### Output

On success, the `status` of the OPML response will be set to 200 and a single text element will be returned with instructions for the user (it will say something along the lines of “Please visit TuneIn.com/mydevice and enter the code ‘xyz’”)

## See also

- [methods/authenticate.md](authenticate.md) — the alternative GET-based authentication endpoint
- [methods/preset.md](preset.md) — preset management for the accounts created here
- [methods/browse.md § Browse Presets](browse.md#browse-presets) — browsing the preset list for an account or device
