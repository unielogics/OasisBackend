# 0140 Root never runs code the oasis user can write
Status: accepted (2026-10-09)

Context: the launch-day review (M2) found that root ran `deploy.sh` from `/opt/oasis/src/backend`, a clone the oasis user owns, and
that `oasis-web` could write every release (`ReadWritePaths=/opt/oasis/releases`). The oasis user runs `pnpm install` with every
dependency's install scripts and the internet-facing services, so a foothold as oasis became root at the next deploy.

* **The kit root runs is a root-owned copy**, `/usr/local/lib/oasis/deploy` (`root:root`, nothing writable by group or others, swapped
  in whole). `install.sh` installs it from the `deploy/` it was started from; `deploy.sh` refreshes it from each release after that
  release went live healthy. Units and the runbook run the scripts from there; `deploy.sh` warns when it is started elsewhere.
  `OASIS_BACKEND_DIR` (the `node_modules` the kit borrows) falls back to the current release for that copy.
* **Releases are root-owned and read-only.** Builds still run as oasis, in `releases/<id>.partial`; then root makes the tree
  `root:oasis` with `chown -R -h` (a link the build planted is never followed) and `chmod -R g+rX,go-w`, and renames it into place.
  `/opt/oasis` and `/opt/oasis/releases` are `root:root`, so the oasis user cannot rename a release or repoint `current`.
* **Verified against the mirror.** The production host's clones fetch from local mirrors; when `/opt/oasis/git/backend.git` exists
  and only root can change it (a fixed path, not the clone's `origin`, which the oasis user could repoint to skip the check), the
  build's `deploy/` must equal the commit's `deploy/` read by root from the mirror, checked before the backup and the migration (a
  difference, or a commit the mirror lacks, stops the deploy with nothing changed). Without a mirror (GitHub) the kit is copied as
  built and the log says it was not cross-checked. The runbook's mirror flow therefore keeps the mirrors root-owned
  (the earlier `chown -R oasis:oasis /opt/oasis/git` is gone) and drops the `git pull` of the clone.
* **The dashboard writes outside the release.** `CacheDirectory=oasis-web` (emptied at each start) replaces the write access to all
  releases; `.next-live/cache` in a release is a symlink to `/var/cache/oasis-web`. `next start` 15.5 was run from a release copy with
  every file read-only: pages, assets and the image optimizer work; nothing else is written. `pnpm migrate` and tsx also run from a
  read-only tree.

Not covered: a build process that keeps a file open across the `chown`; releases built before this change stay oasis-owned until
pruned; ec2-user's passwordless sudo.
