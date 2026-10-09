# 0141 Only root, oasis and ec2-instance-connect reach the instance metadata service
Status: accepted (2026-10-09)

Context: with the instance role, any local process could fetch the role's credentials from `169.254.169.254` and read the
environment secret (review H1). IMDSv2 and a hop limit stop containers and forwarded requests, not local users.

* `oasis-imds-guard.service` (oneshot, `DefaultDependencies=no`, before `network-pre.target` and the Oasis units, enabled `--now` by
  `install.sh`) builds an iptables chain `OASIS-IMDS`, jumped to first from `OUTPUT` for `169.254.169.254/32`: `RETURN` for uid 0,
  `oasis` and (when the user exists) `ec2-instance-connect`, then `REJECT`. Start is idempotent (the chain is rebuilt, the jump added
  once); stop removes every jump and the chain. It is the reviewer's design, inline in the unit so it does not depend on the kit.
* **Root stays allowed** because `amazon-ec2-net-utils` rebuilds the secondary private IP that carries the website's Elastic IP from
  the metadata; cloud-init, the SSM agent and tailscaled are root too. ec2-user tools lose metadata access by design.
* `oasis-web` gets `IPAddressDeny=169.254.169.254/32`: it needs no AWS.
* Emergency removal: `sudo systemctl disable --now oasis-imds-guard`, or the three iptables commands in the unit's comment.
* Tested by running the unit's own commands against an iptables model (exactly those users, one jump, idempotent, clean stop) and
  `systemd-analyze verify`; not run against the real firewall here (that needs root on the live host).
