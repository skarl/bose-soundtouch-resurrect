# Opening up your speaker (one-time, enables SSH)

The speaker has SSH built into its firmware but disabled by default.
Modern SoundTouch firmware (27.x and later) removed the previously-
documented "telnet to port 17000 and run `remote_services on`" path.
The remaining way in is via a USB stick with a specific marker file.

You only have to do this once per speaker. After it's done, SSH stays
on across reboots. (A factory reset wipes the marker file and you'd
have to redo the USB step.)

## What you need

- A **micro-USB OTG adapter** (~€3). The speaker's service port is
  micro-USB-B, not USB-A — you cannot plug a normal flash drive in
  directly without an OTG adapter or a dual-end stick that already has
  a micro-USB connector.
- A **FAT32-formatted USB stick**, ideally ≤ 8 GB. Larger sticks
  sometimes work but reports are inconsistent. **Not exFAT, not NTFS.**
- Physical access to the speaker so you can power-cycle it.

## Step 1 — Format the stick FAT32

If your stick is a different filesystem, reformat it.

```bash
# macOS (replace /dev/diskN with your stick's device — check `diskutil list`):
diskutil eraseDisk MS-DOS USBSTICK MBRFormat /dev/diskN
```

```bash
# Linux (replace /dev/sdX with your stick — check `lsblk`):
sudo mkfs.vfat -F 32 -n USBSTICK /dev/sdX1
```

```powershell
# Windows (PowerShell, elevated). Replace E: with your stick's drive letter:
Format-Volume -DriveLetter E -FileSystem FAT32 -NewFileSystemLabel USBSTICK -Force
```

Some community sources mention that the partition's **bootable flag**
also needs to be set in the partition table. Recent setups don't seem
to require this, but if step 4 below doesn't take, try setting it:

```
# Windows: diskpart
#   list disk
#   select disk N
#   list partition
#   select partition 1
#   active
#   exit
```

## Step 2 — Drop the marker file at the stick's root

Create an empty file named exactly `remote_services` (no extension) at
the **root** of the stick.

```bash
# macOS — also strip macOS hidden files that prevent detection:
touch /Volumes/USBSTICK/remote_services
mdutil -i off /Volumes/USBSTICK 2>/dev/null
rm -rf /Volumes/USBSTICK/.fseventsd /Volumes/USBSTICK/.Spotlight-V100
rm -f  /Volumes/USBSTICK/._*
sync
```

```bash
# Linux:
touch /media/$USER/USBSTICK/remote_services
sync
```

```powershell
# Windows:
New-Item -ItemType File -Path E:\remote_services -Force
```

(There's a helper script at `scripts/enable-ssh-stick.sh` that does
this for you on macOS and Linux. See the comments in that script.)

## Step 3 — Power-cycle the speaker with the stick inserted

The speaker only scans the USB stick at boot. Soft reboots through the
SoundTouch app don't trigger it.

1. **Unplug the speaker from mains** (there's no soft power-off).
2. Insert the USB stick into the rear USB port via your OTG adapter.
3. **Plug power back in.** Wait for full boot — the front LED stops
   blinking once boot is complete (typically 30–60 seconds).
4. Pull the USB stick out. You don't need it again unless you factory-
   reset the speaker.

## Step 4 — Try SSH

The speaker uses an old SSH host key algorithm; modern OpenSSH refuses
it by default and you have to opt in:

```bash
ssh -oHostKeyAlgorithms=+ssh-rsa root@<speaker-ip>
# user:     root
# password: (none — passwordless)
```

If you see a shell prompt, you're in. **Don't disconnect yet** — read
step 5 first.

If SSH refuses with `no matching host key type`, you missed the
`-oHostKeyAlgorithms=+ssh-rsa` flag.

If SSH refuses with `connection refused`, the USB step didn't take.
Common causes:

- Stick wasn't FAT32. Reformat (step 1) and retry.
- macOS hidden files (`.fseventsd`, `._*`) on the stick. Strip them
  (step 2) and retry.
- Faulty OTG adapter. Try a different one — they're cheap and
  individual ones can be flaky.
- Stick too large. Try a ≤ 8 GB one if available.
- Speaker booted with the stick already inserted but not fully
  detected. Pull the stick, power off, re-insert before powering on,
  retry.

## Step 5 — Persist SSH across reboots

The USB-stick marker only writes `/tmp/remote_services` (RAM, lost on
reboot). To make SSH survive future reboots, while you're SSH-ed in
run:

```sh
touch /mnt/nv/remote_services
```

`/mnt/nv` is the speaker's persistent NVRAM partition; this marker
survives reboots.

A factory reset wipes `/mnt/nv` and undoes this — you'd need the USB
stick again.

## Step 6 — Tighten host key checking on your laptop (optional)

By default, repeated SSH connections will keep adding host keys to
`~/.ssh/known_hosts` if the speaker's key changes (e.g. after
firmware reinstallation). If you only ever talk to one speaker, that's
fine. For deployment scripts in this repo, we use
`-oUserKnownHostsFile=/dev/null -oStrictHostKeyChecking=no` to avoid
the friction — that's why the helper scripts spell those flags out.

## Reverting

To disable SSH:

```sh
ssh -oHostKeyAlgorithms=+ssh-rsa root@<speaker-ip> '
  rm -f /mnt/nv/remote_services /tmp/remote_services
  reboot
'
```

A factory reset (hold the volume-down + multifunction buttons; check
your model's service manual for the exact combo) also achieves this,
plus wipes everything else under `/mnt/nv`.

## What you've enabled

After this, root SSH is available on TCP 22 of your speaker, no
password. **This is a significant security posture change** —
treat the LAN your speaker sits on as the trust boundary, and never
expose port 22 of the speaker to the public internet.

The speaker also exposes a TAP diagnostic console on TCP 17000 if
you ever lose SSH:

```bash
echo "help" | nc -w 5 <speaker-ip> 17000
```
