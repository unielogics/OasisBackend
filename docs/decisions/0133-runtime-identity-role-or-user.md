# 0133 The app's AWS identity: the instance role (recommended) or a key file, chosen by a flag
Status: accepted (2026-10-09). Amends 0111.

The application host is an EC2 instance (Amazon Linux 2023) that also runs development agents as `ec2-user`, who has sudo, so
isolation between local processes is not a security boundary here. AWS recommends an instance role for code on EC2; the alternative is
a narrow IAM user whose key sits in a root-only file. The owner chooses; both are built, and the role is the documented recommendation.

* **`--runtime role` (default)**: IAM role `oasis-app-role` whose trust policy admits only `ec2.amazonaws.com`, the managed policy
  `oasis-app-runtime` attached, instance profile `oasis-app-profile` holding it, and the association with the instance named by
  `--instance-id`, or found by `--private-ip` through `ec2:DescribeInstances` (exactly one non-terminated match, else a clear error).
  The instance is never identified through instance metadata. An instance that already has an instance profile keeps it: the plan
  prints what is associated and skips; `--replace-instance-profile` replaces it. A profile that holds another role is refused. A new
  profile is retried for about 30 seconds while IAM propagates it to EC2. On the host nothing is stored; the SDK's default chain gets
  short-lived credentials from the instance.
* **`--runtime user`**: the `oasis-app` IAM user with the same policy and one access key, written to `--out` in the AWS credentials file
  format (O_EXCL, 0600) for `/etc/oasis/aws-credentials` (owner root, mode 0600). systemd's `LoadCredential=` hands the file to the
  services and `AWS_SHARED_CREDENTIALS_FILE=%d/aws-credentials` points the SDK at it, with `AWS_EC2_METADATA_DISABLED=true`; root-run
  deploy scripts give the service user a private copy for the one command. The status endpoint reports `shared-credentials-file`.
* **Nothing is deleted when switching.** A role run notes a leftover `oasis-app` user so its key can be deactivated by the owner.
* **Why the role**: no long-lived key exists anywhere (files, backups, copies), AWS rotates the credentials, and there is nothing to
  rotate by hand. Neither option protects the app from a local root process on this host; IMDSv2 with hop limit 1 is recommended to
  keep containers and forwarded requests away from the role.
* **Operator tools never use the runtime identity**: `aws:provision` and `secrets:push` require `--profile` or explicit keys and disable
  the metadata service for themselves.
