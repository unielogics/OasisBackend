# Runbook

What to do, in order, for the jobs that come up and the things that go wrong. Background and the layout of the host are in
[deployment.md](deployment.md); checking the tablet, Squarespace and AWS is in [live-verification.md](live-verification.md).

Conventions: commands run on the server. `D=/usr/local/lib/oasis/deploy/scripts` is the kit's script directory: a root-owned copy
that `install.sh` puts there and every healthy deploy refreshes. Never run the kit as root from `/opt/oasis/src` or a release: the oasis
user can change those (deployment.md, "Privilege separation"). "Sign in" means
https://your-domain/login. Anything that changes the system needs `sudo`. In commands, `$D/oasis-admin.sh ... COMMAND` stands for
`$D/oasis-admin.sh --email you@example.com COMMAND`: it asks for your password (or reads `OASIS_ADMIN_PASSWORD`) and needs the
"Billing & integrations" permission, which a Super Admin has.

| I want to | Command |
|---|---|
| see whether everything is up | `$D/healthcheck.sh` (API, dashboard, the public sign-in redirect, the worker) and `systemctl status oasis-api oasis-worker oasis-web` |
| read the logs | `journalctl -u oasis-api -f` (also `oasis-worker`, `oasis-web`; `--since '30 min ago'`) |
| deploy the latest code | `sudo $D/deploy.sh` |
| publish the public website | `sudo $D/site-deploy.sh` (section 10) |
| go back to the previous release | `sudo $D/rollback.sh` |
| take a backup now | `sudo -u oasis $D/backup.sh --label manual` |
| prove the latest backup restores | `sudo systemctl start oasis-restore-drill; journalctl -u oasis-restore-drill -n 40` |
| check the money ledger | `sudo -u oasis $D/ledger-check.sh` |
| look at the tablet and Squarespace | `$D/oasis-admin.sh --email you@example.com status` |
| test the integrations | `sudo $D/verify.sh all` (see live-verification.md) |

---

## 1. First-time setup

Do these in order; each step ends with something you can check.

1. **Host and DNS.** An Amazon Linux 2023 instance with about 8 GB of memory (or swap), ports 80 and 443 open in the security group, a DNS
   record for the domain pointing at it. Check: `dig +short your-domain` shows the instance address.
2. **Run the installer** (dry run first):
   ```bash
   sudo deploy/scripts/install.sh --domain your-domain --email you@example.com --dry-run \
        --install-packages --install-postgres --local-db --drill-role --gen-deploy-keys
   ```
   Read the plan, then run it without `--dry-run`. It prints the public halves of two SSH deploy keys. Add each as a **read-only deploy
   key** on its GitHub repository. The app's AWS identity: `--aws-runtime role` (default, recommended) or `user`
   ([aws-setup.md](aws-setup.md)).
   Check: `ls /etc/oasis` shows `common.env api.env worker.env web.env drill.env secret-seed.env`; `systemctl list-unit-files 'oasis*'`
   lists the units.
3. **The secret, and the encryption key.** With the AWS side provisioned ([aws-setup.md](aws-setup.md), steps 1 to 5), push
   `/etc/oasis/secret-seed.env` into the secret (the commands install.sh printed; aws-setup.md step 6). Copy `SECRETS_KEY` from it into
   your password manager: without it, stored credentials (the tablet, Squarespace) cannot be read from a restored database. Then shred
   every copy of the seed.
4. **Clone the repositories** (as the installer suggests): re-run `install.sh` with `--backend-repo` and `--dashboard-repo`, using the
   aliases `git@github-oasis-backend:OWNER/OasisBackend.git` and `git@github-oasis-dashboard:OWNER/OasisDashboard.git`.
   Check: `ls /opt/oasis/src/backend/deploy/scripts`.
5. **First deployment:** `cd / && sudo $D/deploy.sh` (the kit install.sh put in place; the first build takes several minutes). Check:
   it ends with `release ... is live`, `https://your-domain/healthz` answers `{"status":"ok"}`, and `ls -l /opt/oasis/current/` shows
   `root oasis`.
6. **First Super Admin:** `sudo $D/bootstrap-admin.sh set you@example.com --profile <operator profile>` (it goes into the secret), note
   the password, `sudo systemctl restart oasis-api`, sign in, change the password, then
   `sudo $D/bootstrap-admin.sh clear --profile <operator profile>` and `sudo systemctl restart oasis-api`.
7. **Tailscale** (for the tablet): install and join the tailnet (`sudo tailscale up --hostname=oasis-api`), then in the admin console
   enable MagicDNS and HTTPS certificates, tag the nodes, add the two ACL rules and disable key expiry on both nodes
   ([deployment.md](deployment.md), "The tailnet side"). Then `sudo $D/tailscale-serve.sh` and put the URL it prints into `common.env`
   as `SMSGATE_WEBHOOK_PUBLIC_URL`.
8. **Settings in the dashboard:** working hours, closures, employees and roles, packages (Settings screens).
9. **Integrations**, each with its own check: the tablet (section 6), Squarespace (section 7), AWS S3 now and SES last (everything with
   `pnpm aws:provision` and the operator key, exactly as in [aws-setup.md](aws-setup.md), then
   [live-verification.md](live-verification.md), "AWS"). They are off (`sim`) until you switch them: in `common.env` set
   `SMS_PROVIDER=smsgate`, `SQSP_PROVIDER=live`, `EMAIL_PROVIDER=ses`, `STORAGE_PROVIDER=s3` one at a time, `sudo systemctl restart
   oasis-api oasis-worker` after each. `GET /api/v1/system/integrations` (Super Admin) then says per integration whether it is
   configured, which settings are still missing, and the last success and last error.
10. **Backups:** `sudo -u oasis $D/backup.sh --label manual`, then the restore drill (section 4). Check `systemctl list-timers 'oasis*'` shows
    the nightly backup, the monthly drill and the health check. Set `BACKUP_S3_URI` and an encryption key for the off-host copy.
11. **Acceptance run:** `sudo $D/verify.sh all --send --sms-to +1... --email-to you@... --instance-profile` with the tablet in your hand.

---

## 2. Deploy

```bash
sudo $D/deploy.sh --dry-run        # what would happen: refs, steps
sudo $D/deploy.sh                  # origin/main of both repositories
sudo $D/deploy.sh --backend-ref origin/hotfix --dashboard-ref origin/main
```

It stops by itself if nothing changed. Watch for: `pre-deploy backup` (a failure stops the deploy; fix it, or `--skip-backup` if you
accept the risk), `applying migrations` (a failure changes nothing that runs), `restarting ...`, then `release <id> is live`. If the new
release is unhealthy it rolls itself back and exits 1; the failed build stays in `/opt/oasis/releases/<id>.failed` and the reason is in
`journalctl -u oasis-api -u oasis-worker -u oasis-web --since '10 min ago'` and `/var/log/oasis/deploy.log`.

**Before you merge a migration**, check it against the previous release: the old code must still run on the new schema, because a
rollback leaves the schema as it is. Add things first; remove or rename them in a later release.

Deploy outside shop hours when you can: the restart takes the dashboard and API down for a few seconds, and SSE clients reconnect and
refetch by themselves.

### This host: releases come from local mirrors

On the production host (EC2 i-016774195f325eb0f) the clones in `/opt/oasis/src` do not pull from GitHub: their `origin` is a bare
mirror in `/opt/oasis/git/<repo>.git`, and only commits that passed the integrator's checks are published into it, so no deploy
key is needed on the host. The mirrors belong to **root** and nothing in them is writable by group or others (once:
`sudo chown -R root:root /opt/oasis/git && sudo chmod -R go-w /opt/oasis/git`); the oasis user only reads them. `deploy.sh` then
compares the kit inside every build with the commit's `deploy/` in `/opt/oasis/git/backend.git` before anything runs, and the kit
root copies afterwards is exactly what was published. To release (as the operator, from the working copies in `~ec2-user/oasis`):

```bash
G="env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=*"   # root reading repositories other users own
for r in backend dashboard; do
  sudo $G git -C /opt/oasis/git/$r.git fetch --quiet /home/ec2-user/oasis/$r +main:main
done
cd / && sudo /usr/local/lib/oasis/deploy/scripts/deploy.sh        # fetches origin/main into /opt/oasis/src itself
```

No `chown` of the mirrors to oasis any more (that made them, and so the kit, the oasis user's to change), and no `git pull` of the
`/opt/oasis/src` checkout: `deploy.sh` fetches and exports by commit, and runs from the root-owned kit. A deploy whose kit does not
match the mirror stops before the backup with "the deploy kit in the built release differs"; with a mirror that is not root-only it
says "can be changed by users other than root ... not cross-checked" and goes on. After a release that changes the deployment configuration (the deploy says so), re-run
`sudo /usr/local/lib/oasis/deploy/scripts/install.sh` with the same options (the kit is already the new one); it never overwrites
`/etc/oasis/*.env` but reports variables a newer template added.

## 3. Roll back

**Code only** (the usual case, a bad release but a compatible schema):
```bash
sudo $D/rollback.sh --list          # releases, current and previous marked
sudo $D/rollback.sh                 # back to the previous release; exit 3 if it is not healthy
sudo $D/rollback.sh --to <release id>
```
Running it again rolls forward. Nothing is rebuilt; the old release directory is switched back in and the services restart.

**Code and data** (a migration damaged data or broke the old code): roll back the code first, then restore the `pre-deploy` backup
taken minutes earlier by `deploy.sh` (section 4, "Restore for real"). Everything entered after that backup is lost, so decide quickly and
tell the shop what they need to re-enter.

---

## 4. Backups and restore

**What exists.** Nightly at 03:15 shop time (7 kept), the Sunday one for 4 weeks, the one from the 1st of each month for 12 months, plus
`pre-deploy`, `pre-rotate` and `manual` ones, in `/var/backups/oasis/{daily,weekly,monthly}`. Each has a checksum and a manifest of row
counts. With `BACKUP_S3_URI` an encrypted copy of every run is uploaded.

**Check it is happening:** `ls -l /var/backups/oasis/daily | tail`, `systemctl list-timers oasis-backup.timer`,
`cat /var/lib/oasis/drills/*.json | tail -n 3`, and `systemctl --failed`. A failed backup or drill is also appended to
`/var/log/oasis/failures.log`.

**Prove a backup restores (monthly, automatic):**
```bash
sudo systemctl start oasis-restore-drill.service ; journalctl -u oasis-restore-drill -n 40
```
Every line should read `PASS`, ending with `restore drill passed`. A `FAIL` names the problem: a bad checksum (the file changed or the disk
is failing), `pg_restore` errors, row counts that differ from the manifest, or a ledger invariant. Treat a failed drill as an incident:
take a fresh `manual` backup and run the drill on that to see whether the problem is the file or the database.

**Restore for real.** The database is damaged or lost; you have a dump (or you pull one from S3: `aws s3 cp s3://bucket/prefix/NAME.dump.enc .`,
then `BACKUP_ENCRYPTION_KEY_FILE=/path/key node /usr/local/lib/oasis/deploy/lib/backup-crypt.mjs decrypt NAME.dump.enc NAME.dump`).
```bash
sudo systemctl stop oasis-api oasis-worker oasis-web
# keep the damaged database for evidence
sudo -u postgres psql -c 'alter database oasis rename to oasis_damaged'
sudo -u postgres psql -c 'create database oasis owner oasis'
sha256sum -c NAME.dump.sha256                                        # if you have the sidecar
sudo -u postgres pg_restore --no-owner --role=oasis -d oasis --exit-on-error NAME.dump
# bring the schema up to the current release (a no-op if the dump is current)
cd /opt/oasis/current/backend && sudo -u oasis bash -c 'set -a; . /etc/oasis/common.env; . /etc/oasis/api.env; set +a; pnpm migrate up'
# (DATABASE_URL comes from the secret common.env names; with runtime=user add
#  AWS_SHARED_CREDENTIALS_FILE=<a copy of /etc/oasis/aws-credentials the oasis user can read> AWS_EC2_METADATA_DISABLED=true)
```
Before starting the services, **stop texts from going out twice.** The restored queue still shows messages as pending that were
actually sent after the backup was taken. In `/etc/oasis/common.env` set `SMS_DISPATCH_MODE=off`, then:
```bash
sudo systemctl start oasis-api oasis-worker oasis-web
$D/oasis-admin.sh --email you@example.com raw GET '/api/v1/messages/outbox?state=pending'
```
Cancel what you recognise as already sent (`POST /messages/:id/cancel`), then set `SMS_DISPATCH_MODE=jobs` and restart the API and the
worker. Texts have short lifetimes (a reminder expires after 2 hours, a welcome after 15 minutes), so stale ones drop on their own.
Then: `ledger-check.sh` (section 9, "Ledger mismatch"), `healthcheck.sh`, a Squarespace "Sync now" (it re-reads recent orders and
re-matches), and tell staff the time of the restore point. Browsers refetch by themselves (the event stream reports a `resync`).
When you are satisfied, `sudo -u postgres psql -c 'drop database oasis_damaged'`.

**Restore one thing** (a single deleted customer, say): restore the dump into a scratch database with the drill in `--keep` mode
(`restore-drill.sh --latest --keep`, which prints the scratch database name), read the rows from it with `psql`, and re-enter them
through the dashboard. Do not copy rows between databases by hand: the ledger is append-only and sequence numbers are per database.

---

## 5. Users and roles

Everything here is in the dashboard, Settings.

* **Add an employee:** Employees, Add. Name and mobile number are required; pick a role (default Crew). They receive an invitation by
  text (by email if there is no usable tablet) with a link valid for 7 days; they set an email and a password and are signed in.
  "Resend invite" sends a fresh link and revokes the older ones.
* **Roles and permissions:** Roles & permissions. Five built-in roles (Super Admin, Management, Accounting, Support, Crew) with 27
  permissions between them, plus custom roles. Refund, adjustment and credit **limits** are per transaction, set per role, and only a
  Super Admin may change them. A person can also have per-person Allow or Deny exceptions. Only a Super Admin can grant "Billing &
  integrations", "Void payments" or the Super Admin role. There is always at least one active Super Admin: demoting or deactivating the
  last one is refused.
* **Someone left:** Deactivate (revokes every session at once). Reactivate restores them.
* **Someone forgot their password:** they use "Forgot password" on the sign-in page, or a manager sends a reset (a 24-hour link by text or
  email; `POST /api/v1/employees/<id>/password-reset`, which `oasis-admin.sh ... raw POST ...` can call if the screen has no button yet).
  Nobody can read another person's link.
* **A new Super Admin when you cannot sign in as one:** section 9, "Locked-out Super Admin".
* **A login for an existing employee from the command line:** `cd /opt/oasis/current/backend && sudo -u oasis env $(grep -v '^#'
  /etc/oasis/common.env | xargs) pnpm user:create -- --email a@b.c --first Amara --roles super --password-stdin < pw.txt` (it reads the
  secret named in `common.env` for `DATABASE_URL`, like the services).

---

## 6. Add or replace the SMS tablet

You need a tablet or phone with a SIM that can **send and receive SMS** (a Wi-Fi-only tablet cannot), Android 8 or later, kept plugged in.

**Prepare the tablet** (details and the reasons are in `docs/integrations/smsgate.md` section 3):
1. Install SMS Gate (Play Store, F-Droid or the GitHub release). Grant SMS, phone and notification permissions.
2. In the app: Local Server on (port 8080), note the username and password, press the button to start it.
3. Settings, Webhooks: set a strong **signing key** (keep it: `gen-secrets.sh SMSGATE_WEBHOOK_SECRET` makes one). Settings, Messages:
   processing order **FIFO**, send interval 3 to 6 seconds. Settings, Ping: 60 seconds.
4. Battery: SMS Gate and Tailscale both **Unrestricted**; adaptive battery and "put unused apps to sleep" off; allow autostart if the
   vendor has the switch.
5. In the Messages app turn **chat features / RCS off** for that SIM.
6. Install **Tailscale** on the tablet, sign in to the same tailnet, **Always-on VPN** on (do not block connections without VPN).

**Register it with Oasis:**
```bash
tailscale ip -4                     # on the tablet or in the Tailscale admin: its 100.x.y.z address
curl -m 5 http://100.x.y.z:8080/health        # from the server: expect "pass"
$D/oasis-admin.sh --email you@example.com sms-add-device --label "Front desk tablet" \
     --device-url http://100.x.y.z:8080 --username <app user> --password-env TABLET_PASSWORD \
     --webhook-secret-env TABLET_SIGNING_KEY       # the same key you typed into the app
```
(`export TABLET_PASSWORD=...` and `TABLET_SIGNING_KEY=...` first, or leave `--password-env` out to be asked. Without
`--webhook-secret-env` the command generates a key and prints it once; type that into the app.) Then:
```bash
$D/oasis-admin.sh ... sms-test <device id>              # reachable, credentials ok
sudo $D/tailscale-serve.sh                              # once per host; prints SMSGATE_WEBHOOK_PUBLIC_URL for common.env
$D/oasis-admin.sh ... sms-register-webhooks <device id> # seven oasis-* webhooks on the tablet
sudo $D/verify.sh smsgate --send --to +1YOURNUMBER --watch --replies   # one text out, receipts, then reply C, STOP, START, HELP
```
Set `SMS_PROVIDER=smsgate` in `common.env` and restart the API and the worker. Nothing else goes in the environment: the tablet's URL,
password and signing key live (encrypted) in its device record, which is what the application reads. The `SMSGATE_DEVICE_URL`,
`_USERNAME`, `_PASSWORD` and `_WEBHOOK_SECRET` lines in `common.env` are only for `verify.sh smsgate` and may stay commented out.

**Replace a tablet** (broken, or a new SIM):
1. Prepare the new tablet as above and add it as a second device. Run `sms-test` and `sudo $D/verify.sh smsgate --send ...` against it.
2. Disable the old one: `oasis-admin.sh ... sms-update-device <old id> --disable`. If you keep the `SMSGATE_*` lines for
   `verify.sh smsgate`, point them at the new device.
3. If the phone **number** changed, customers who reply to the old number reach nobody: tell them (the welcome text carries the new
   number), and keep the old SIM somewhere you can read it for a few weeks. Opt-outs (STOP) are kept per customer in the database, not per tablet.
4. Texts still queued are sent by whichever enabled device takes them; disable the old device first if you do not want that.
5. Remove the old tablet from the tailnet (Tailscale admin, Machines, Remove) so its key can no longer reach the server.

**Same tablet, new address or password:** `sms-update-device <id> --device-url ... --password-env ...`, then `sms-test`.

---

## 7. Connect Squarespace and map the products

Squarespace stays the card processor; Oasis only reads it (orders, transactions, contacts). Staff take card payments in Squarespace, record
them in Oasis, and Oasis confirms them when the money shows up there.

1. **Key.** In Squarespace: Settings, Advanced, Developer API Keys, create a key with **Orders, Transactions and Contacts set to Read
   Only** (nothing else; the plan must include Commerce Advanced). It is shown once.
2. **Check it without changing anything:**
   ```bash
   sudo SQSP_API_KEY=<the key> $D/verify.sh squarespace --days 90 --capture /var/lib/oasis/live-verification/captures
   ```
   Read the report in `/var/lib/oasis/live-verification/`. It lists the products it found and **proposes a product map** (membership tiers with
   their renewal period, services) in `<date>-squarespace-product-map.proposed.json` beside it. Nothing is written to Oasis.
3. **Review the proposal.** A product becomes a membership only if its name or SKU says which tier it is (Essential, Premium, Executive,
   Exotic) and customers re-buy it, or it is called a membership/subscription. Fix names and tiers by hand in the file.
4. **Store the key and switch:** `SQSP_KEY=<key> $D/oasis-admin.sh ... sqsp-connect --key-env SQSP_KEY` (it verifies the key against
   Squarespace first and stores it encrypted with `SECRETS_KEY`), then `SQSP_PROVIDER=live` in `common.env` and restart the API and worker.
   `SQSP_API_KEY` in `common.env` is optional (a fallback; the stored key wins when both exist).
5. **Load the map:** `$D/oasis-admin.sh ... sqsp-product-map --file <the proposal>`, then `... sqsp-sync-now`. Orders that were ignored only
   because no product was mapped become unmatched again and are matched.
6. **Watch it settle:** `... sqsp-status` (lag, orders waiting, dead letters) and the Payments screen's reconciliation list. Orders the
   matcher is not sure about wait in the manual queue with suggestions; nothing is applied below the confidence threshold.
7. **Make one real test payment the way staff will take it** and confirm it appears: that decides how the shop collects (checkout link,
   invoice, POS), which Squarespace does not document.
8. **Webhooks are optional** (a faster path than polling every two minutes). They need an OAuth app; the public endpoint is
   `https://your-domain/hooks/squarespace`. `sudo $D/verify.sh squarespace --post-webhook https://your-domain/hooks/squarespace` proves the endpoint
   and the signature path.

---

## 8. Rotate secrets

**Rotating a value in the secret** (the general recipe): write the new `NAME=value` into a private one-line file (`umask 077`), then
```bash
pnpm secrets:push --profile oasis-admin --secret-id oasis/prod/app --from new.env           # the plan: "~ NAME (changes)"
pnpm secrets:push --profile oasis-admin --secret-id oasis/prod/app --from new.env --apply && shred -u new.env
sudo systemctl restart oasis-api oasis-worker          # the services read the secret at start only
```
Secrets Manager keeps the previous value as the `AWSPREVIOUS` version (to go back: push the old value again). `--remove NAME` deletes
a key. The operator key is needed for this; create a fresh one for the occasion and deactivate it afterwards ([aws-setup.md](aws-setup.md)).
On a host without the secret (`--secrets-in-files`), edit the line in `common.env` instead.

| Secret | Where | How | What people notice |
|---|---|---|---|
| `SECRETS_KEY` (encrypts stored tablet and Squarespace credentials) | the secret | **not** with a plain push (the stored credentials must be re-encrypted): `sudo $D/secrets-rotate.sh --generate` (dry run), then `sudo $D/secrets-rotate.sh --new-key-file /etc/oasis/secrets-key.new --profile <operator profile> --apply` (`pnpm secrets:rotate` re-encrypts, then the new key is pushed into the secret). Store the new key in the password manager, then shred the key file | API and worker stop for under a minute |
| `SESSION_SECRET` | the secret | the recipe above (`gen-secrets.sh SESSION_SECRET > new.env`) | everyone is signed out |
| Database password | role `oasis`, `DATABASE_URL` in the secret | `sudo -u postgres psql -c "alter role oasis password 'NEW'"`, push the new `DATABASE_URL`, restart all three; update `drill.env` if you rotate `oasis_drill` | a short outage |
| Tablet password | SMS Gate app, device record | change it in the app, then `oasis-admin.sh ... sms-update-device <id> --password-env VAR` (and `SMSGATE_PASSWORD` in the secret if you keep it for `verify.sh smsgate`) | none |
| Tablet webhook signing key | SMS Gate app, device record | `sms-update-device <id> --webhook-secret-env VAR`, set the same key in the app, `sms-register-webhooks <id>` (and `SMSGATE_WEBHOOK_SECRET` in the secret if kept for `verify.sh smsgate`) | texts from customers pause until both sides match |
| Squarespace API key | the database (encrypted), optionally the secret | create a new key, `sqsp-connect --key-env VAR` (and `SQSP_API_KEY` in the secret if you keep the fallback), restart, then revoke the old key in Squarespace | none |
| Squarespace webhook secret | Squarespace subscription, `SQSP_WEBHOOK_SECRET` in the secret | rotate in Squarespace (it returns the new hex once), push it, restart the API | none |
| AWS identity of the app | runtime=role: nothing to rotate (AWS rotates the instance role's credentials). runtime=user: `/etc/oasis/aws-credentials` | runtime=user, with the operator key: `pnpm aws:provision ... --runtime user --new-access-key --out <new file> --apply` (the old key keeps working), `sudo install -o root -g root -m 0600 <new file> /etc/oasis/aws-credentials`, restart API and worker, check `GET /api/v1/system/integrations`, then the owner deactivates and deletes the old key in the IAM console ([aws-setup.md](aws-setup.md)) | none |
| The operator (administrator) key | the integrator's `~/.aws/credentials` | the owner deactivates it after every setup session and creates a fresh one when needed; nothing the app runs with depends on it | none |
| Backup encryption key | `BACKUP_ENCRYPTION_KEY_FILE` | `node deploy/lib/backup-crypt.mjs keygen NEWFILE`, point `backup.env` at it. **Keep the old key** to read older backups | none |
| Deploy keys | GitHub, `/var/lib/oasis/.ssh` | `install.sh --gen-deploy-keys` after removing the old key files, add the new public keys, delete the old ones on GitHub | none |

If a secret may have leaked, rotate it now and then look at what it could do: a leaked `SESSION_SECRET` lets an attacker forge cookie
signatures (the server-side session must still exist, but rotate anyway); a leaked `SECRETS_KEY` plus a database copy reveals the tablet
and Squarespace credentials (rotate those at their source as well); a leaked tablet signing key lets someone fake customer replies.

---

## 9. When something goes wrong

### The site does not load, or the dashboard shows errors
1. `$D/healthcheck.sh` shows which part fails. `systemctl status oasis-api oasis-worker oasis-web nginx postgresql`.
2. API down: `journalctl -u oasis-api --since '15 min ago'`. `Invalid environment` means a bad line in an env file (the message names the
   variable). A database error: is Postgres up, is the disk full (`df -h`)?
   A line about the secret stops the service before anything else: `secret "oasis/prod/app" in us-east-1 does not exist` (create and
   fill it: aws-setup.md), `access denied reading secret ...` (runtime=role: is `oasis-app-profile` associated with this instance,
   `aws ec2 describe-iam-instance-profile-associations` with the operator profile; runtime=user: does `/etc/oasis/aws-credentials` exist
   and hold the oasis-app key), `no AWS credentials ...` (the same two questions), `holds keys the environment contract does not
   declare: X` (`pnpm secrets:push ... --remove X --apply`). The secret's values are never in the journal.
3. 502 from nginx: the API or dashboard is not listening; `ss -ltn | grep -E '4000|3200'`.
4. After a deploy: `sudo $D/rollback.sh`.
5. Certificate expired: `sudo certbot renew --dry-run`, `systemctl status certbot-renew.timer`; DNS still pointing here?
6. "The domain does not answer" but the health check is fine: check the name the person typed. Only the dashboard's host
   (`app.<domain>`) and, once `install.sh --site-domain` ran, the bare domain and `www` (the public website, section 10) point here;
   each needs its own record in the DNS zone (a record named literally `@` in Route 53 is NOT the zone apex: there the apex is the
   empty name). From outside: `dig +short <name> @1.1.1.1`, then `curl -sI https://<name>/`. This host also refuses any other name
   or a bare IP address on purpose (port 80 closes the connection, port 443 refuses the TLS handshake), so `https://<the Elastic IP>/`
   failing is expected.

### SMS device down
*Sign: a "Needs attention" card about the tablet, texts stay "Queued", customers' replies do not appear.*
1. `$D/oasis-admin.sh ... sms-health <id>` and `sms-test <id>`: unreachable, credentials rejected, or reachable but with a failing health
   status (battery below 10% reports `fail`).
2. Unreachable: is the tablet on and charging? Is Tailscale connected on it (the app shows the VPN key)? `tailscale ping <tablet>` from the
   server. A key that expired shows as the node being offline for months: re-authenticate it, and disable key expiry
   (`docs/integrations/smsgate.md` section 3).
3. Reachable but silent: the SMS Gate app was killed by the battery manager (it reports `app:started` when it comes back; webhooks are
   re-registered by themselves). Open the app, set battery to Unrestricted. Is a "send many messages" dialog waiting on the screen?
   Tap it away and lower `SMSGATE_MAX_PER_WINDOW`.
4. Texts go out but nothing comes back (no receipts, no replies): `sms-register-webhooks <id>`; `sudo $D/tailscale-serve.sh --status`;
   from outside the tailnet `healthcheck.sh --public https://your-domain` (must show the SMS hook hidden); `sudo $D/verify.sh smsgate --watch`.
5. While it is down nothing is lost: texts wait in the queue and expire per their class (a "ready for pickup" text lives 4 hours, a
   reminder 2). Staff phone customers whose "ready" or "late" text matters.

### Squarespace sync stuck or dead-lettered
*Sign: payments stay "Awaiting Squarespace", the sync status card shows lag or a dead letter, new orders do not appear.*
1. `$D/oasis-admin.sh ... sqsp-status`: connection state, `lag`, `deadLetters`, `manualQueueOpen`, the last error.
2. Is the worker running (`systemctl status oasis-worker`)? The sync is a job; with the worker down nothing polls.
3. 401/403 in the error: the key was revoked or lost a permission; create a new one (section 7, step 1) and `sqsp-connect`. 429s are handled by
   the client (it waits a minute); persistent ones mean something else uses the same key.
4. After the cause is fixed: `... sqsp-sync-now --resume` clears a dead-lettered resource and runs again; `--rematch` also re-offers the
   manual queue to the matcher.
5. Orders waiting in the manual queue (`unmatched`) need a person: Payments, reconciliation, "Match" or "Ignore".
6. Card money recorded by staff and not confirmed after 24 hours: the Needs-attention card lists it. Find the order in Squarespace and
   confirm it from the invoice ("Confirm in Squarespace") if the money really arrived.

### Ledger mismatch
*Sign: a drill failed on a ledger check, a total on Payments does not match Squarespace, an invoice balance looks wrong.*
1. `sudo -u oasis $D/ledger-check.sh` (read-only, safe any time). It recomputes every invoice from the raw events and compares with
   what the system shows. All PASS means the books are internally consistent and the difference is with something outside (a payment not
   recorded, a Squarespace refund made outside Oasis, tax rounding); go to 4.
2. A FAIL on "paid and refunded ... equal the sum of events" or on the balance rule means the calculation and the events disagree:
   a bad migration or a hand edit of the SQL functions. **Do not edit `ledger_events`**: it is append-only on purpose (the database
   refuses deletes and edits). Stop, keep the output, restore a drill copy to inspect (`restore-drill.sh --latest --keep`), and compare
   `invoice_calc_of` with `db/migrations`.
3. A FAIL on the guard trigger or duplicated sequence numbers is a database-level problem: restore from the last good backup (section 4).
4. Differences with Squarespace: the Payments reconciliation lists `unmatched` orders and transactions; amounts differ by tax rounding
   (the variance alert threshold is `SQSP_VARIANCE_ALERT_CENTS`, 100 cents); `external_refund` alerts mean a refund was made in
   Squarespace that Oasis did not issue, so it bypassed Oasis's limits and approvals; review it.
5. Corrections are made **in the app** as new events (adjust, refund, credit, void with a reason), never in the database.

### Restore from backup
Section 4, "Restore for real", including the step that stops duplicate texts. Decide first whether you need the data back to the
last night (daily), to just before a deploy (`pre-deploy`), or to a known good week.

### Locked-out Super Admin
Try these in order, the first that works:
1. Another Super Admin, or anyone with "Add & edit employees", sends the person a password reset (Settings, Employees, or `POST /api/v1/employees/<id>/password-reset`).
2. The person uses **Forgot password** on the sign-in page (needs a working tablet or SES).
3. The sign-in throttle is in memory: a person who typed the wrong password repeatedly waits at most 30 seconds per account (two minutes
   per address) between tries, never a lockout; restarting `oasis-api` clears the counters.
4. Break-glass, on the server, which sets the password directly in the database, revokes every session of that person, and records an
   audit entry:
   ```bash
   sudo $D/reset-password.sh owner@example.com            # asks for the new password (hidden); --enable also reactivates a deactivated login
   ```
5. No Super Admin login exists at all: `sudo -u oasis ... pnpm user:create -- --email new@example.com --first Name --roles super --password-stdin`
   creates one (section 5).

---

## 10. The public website

The marketing site (`oasisautospanj.com`, `www` redirects to it) is static files served by the same nginx from
`/var/www/site/current`, built by `site-deploy.sh` from the root-only mirror `/opt/oasis/git/site.git` ([deployment.md](deployment.md),
"The site build contract"; ADR 0145). Its one live piece of data, the opening hours, comes from the API through
`https://oasisautospanj.com/api/v1/public/hours` (nginx proxies exactly that path, cookies stripped, cached 60 s).

**Set it up once** (the order matters: the site's server blocks must exist before DNS points here, because this host refuses unknown
names; the certificate needs DNS to point here):
1. `sudo $D/install.sh <the options this host was installed with> --site-domain oasisautospanj.com` — writes `/etc/oasis/site.env`,
   the placeholder release, and the port-80 bootstrap; certbot fails ("do both DNS records point at this host yet?"): expected, a warning.
2. DNS: A records `oasisautospanj.com` and `www.oasisautospanj.com` to this host's Elastic IP (TTL 300). Check: `dig +short oasisautospanj.com @1.1.1.1`.
3. The same `install.sh` command again: certbot issues one certificate for both names, the full servers go live, and
   `https://oasisautospanj.com/` answers the placeholder ("Oasis Auto Spa — coming soon"). Check: `curl -sI https://oasisautospanj.com/`
   is 200, `curl -sI https://www.oasisautospanj.com/` is 301 to the apex, `curl -sI http://oasisautospanj.com/` is 301,
   `curl -s https://oasisautospanj.com/api/v1/public/hours` is the hours JSON, `curl -sI https://oasisautospanj.com/api/v1/customers` is 404.
4. The mirror: `sudo git init --bare /opt/oasis/git/site.git && sudo chown -R root:root /opt/oasis/git && sudo chmod -R go-w /opt/oasis/git`.
   From then on `install.sh` is re-run with the same options whenever the kit's templates change (section 2), the `--site-*` ones included.

**Publish and deploy** (as the operator, from the working copy in `~ec2-user/oasis/site`, like the application's mirrors):
```bash
G="env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=*"
sudo $G git -C /opt/oasis/git/site.git fetch --quiet /home/ec2-user/oasis/site +main:main
cd / && sudo $D/site-deploy.sh --dry-run      # the commit, the steps
cd / && sudo $D/site-deploy.sh                # build as oasis, verify, switch, health-check (about a minute)
```
It stops by itself when `current` already serves that commit (`--force` rebuilds; `--ref` names another branch, tag or commit of the
mirror; `--skip-hours` builds without the hours snapshot). Watch for `verified dist/`, then `release <id> is live`. A build that fails
or breaks the contract (missing 404.html, marker text absent, a localhost URL, an inline script ...) is kept in
`/var/www/site/releases/<id>.failed` and nothing changes. A release that does not answer through nginx is switched back at once and
kept as `.failed`; the reasons are in `/var/log/oasis/site-deploy.log` and `/var/log/nginx/oasis-site.error.log`. `--keep N` (default
`SITE_KEEP=4`) releases plus current and previous stay; `--list` shows them.

**Roll back:** `sudo $D/site-deploy.sh --rollback` (to `previous`; again to go forward) or `--rollback --to <release id>`; the same
health check runs, exit 3 when it fails. Nothing is rebuilt and nginx is not reloaded: `current` is a symlink.

**When something is wrong:**
* `curl -sI https://oasisautospanj.com/` is not 200: `sudo nginx -t`; `ls -l /var/www/site/current` (a dangling link? `--rollback`);
  `tail /var/log/nginx/oasis-site.error.log`.
* The hours are stale or missing on the site: `curl -si https://oasisautospanj.com/api/v1/public/hours` (`X-Cache-Status` says whether
  nginx answered from its cache; a 502 means the API is down, section 9) and `curl -s http://127.0.0.1:4000/api/v1/public/hours`
  on the host. The site shows its built-in fallback hours when the endpoint fails; the next deploy bakes a fresh snapshot.
* The health check timer complains about `website:` (journalctl -u oasis-healthcheck): the page lost the marker text or `www` stopped
  redirecting; `site-deploy.sh --list` and `--rollback`.
* `certbot renew --dry-run` covers both certificates (the dashboard's and the site's); the renewal hook reloads nginx.
* "the mirror ... can be changed by users other than root": `sudo chown -R root:root /opt/oasis/git && sudo chmod -R go-w /opt/oasis/git`.

### The host cannot resolve its own new name (health check: "answered HTTP 000")

A name created in Route 53 after a resolver already answered "no such record" stays negative in that resolver for the zone's
negative-cache time (the SOA minimum; lowered from 86400 to 300 s on 2026-10-10, but the VPC resolver 172.31.0.2 keeps what it
cached before). Outside resolvers see the record while `curl https://<name>/` on the host fails with HTTP 000 and the health check
reports the website unhealthy; `resolvectl flush-caches` does not help because the stale answer sits in the VPC resolver. Remedy
on the host: an `/etc/hosts` line `127.0.0.1 oasisautospanj.com www.oasisautospanj.com` (nginx serves the names by SNI on every
address), which the production host carries permanently; remove it only if the website moves to another host. certbot is
unaffected (Let's Encrypt resolves the name itself).

## Appendix: where things are

| Question | Answer |
|---|---|
| Which release is running? | `readlink /opt/oasis/current; cat /opt/oasis/current/REVISIONS` |
| What happened on the last deploys? | `tail /var/log/oasis/deploys.list /var/log/oasis/deploy.log` |
| Is the nightly backup running? | `systemctl list-timers oasis-backup.timer; ls -lt /var/backups/oasis/daily \| head` |
| Did a timer fail? | `systemctl --failed; cat /var/log/oasis/failures.log` |
| The configuration | `/etc/oasis/*.env`; the template and the meaning of each variable: `deploy/env/*.env.example` |
| nginx | `/etc/nginx/conf.d/oasis.conf` (the dashboard), `oasis-site.conf` (the website); `sudo nginx -t && sudo systemctl reload nginx` |
| Which website release is live? | `readlink /var/www/site/current; cat /var/www/site/current/REVISION; tail /var/log/oasis/site-deploys.list` |
| Everything the tablet and API do | `docs/integrations/smsgate.md`, `docs/api-spec.md` sections 22 and 23 |
