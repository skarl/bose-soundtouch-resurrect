---
name: Bug report
about: Something isn't working as documented
labels: bug
---

## What happened?

A clear description of the problem.

## What did you expect?

What you thought should happen instead.

## Steps to reproduce

1. ...
2. ...
3. ...

## Speaker info

Run on the speaker (replace `<speaker-ip>`):

```
curl http://<speaker-ip>:8090/info
```

Paste the relevant fields:

- Model:
- Firmware version:

## Resolver state

```sh
ssh root@<speaker-ip> '
  ps w | grep httpd | grep -v grep
  cat /mnt/nv/shepherd/pids
  ls -la /mnt/nv/resolver/bmx/tunein/v1/playback/station/
  grep -E "ServerUrl|RegistryUrl|UpdateUrl" /mnt/nv/OverrideSdkPrivateCfg.xml
'
```

Paste the output.

## Anything else?

Other relevant context, screenshots, log fragments. Don't include
personal data — strip IPs and MAC addresses, replace with placeholders.
