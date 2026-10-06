# 0008 Sessions, CSRF and login throttling

Status: accepted (2026-10-06)

**Sessions** are server-side rows addressed by the sha256 of an opaque 256-bit token carried in an `HttpOnly; SameSite=Lax`
cookie (`Secure` when `COOKIE_SECURE`, `__Host-` prefixed in production behind HTTPS). Idle expiry is 12 hours and slides
(rewritten at most once a minute), absolute expiry is 14 days and never moves. Login always issues a new session and
revokes the one it arrived with; a password change revokes the other sessions, a reset or deactivation revokes all of them.
Only the hash is stored, so a database read or backup yields no usable session. No JWTs: revocation, deactivation and
role changes must take effect on the next request, which a stateless token cannot do without the same lookup.

**CSRF** has two layers. The platform's Origin/Referer check runs first. The second is a synchronizer token: an HMAC of the
session id under the session's own random secret, returned by `GET /auth/csrf`, the login response and `GET /me`, and sent as
`X-CSRF-Token` on every unsafe request of a signed-in caller. It is derivable only with the stored secret, bound to one
session, and stable for the session's life so a page reload needs no extra round trip. SameSite=Lax alone was rejected
(it does not cover same-site subdomains or old browsers); a per-request double-submit cookie was rejected as more moving
parts for no gain on a same-origin API.

**Login throttling** is a progressive delay per client IP and per account, not a lockout. The design's "10 failures lock the
account for 15 minutes" lets anyone lock the owner out by typing a known email (review D9). Here an account gets 4 free
failures and then waits 1, 2, 4 ... seconds up to a 30-second cap, an IP gets 10 free failures and a 120-second cap; a
throttled attempt is refused without evaluating the password (otherwise the delay would not slow guessing) and does not extend
the wait, so an attacker can hold a victim off for at most the cap while being held to a few guesses a minute. Counters decay
after 15 quiet minutes; success clears the account's counter but not the IP's (a valid login cannot launder guesses).
State is in memory per process; moving to several API processes means moving it to Postgres, the interface stays the same.
Responses are generic: unknown email and wrong password are identical, with equalised work (a dummy scrypt verification), and
only a correct password on a deactivated account reveals that state.

**Passwords** use `node:crypto` scrypt in a PHC-style string (`$scrypt$ln=15,r=8,p=3$salt$hash`) so the algorithm and its
cost travel with the hash. `@node-rs/argon2` (the design's first choice) was not taken to keep the dependency set native-free;
the prefix lets a later migration verify old hashes and rewrite them at login (`needsRehash`).

**Invites and resets** are one-time random tokens (hash stored): invites live 7 days, self-service resets 1 hour, admin
resets 24 hours. Accepting an invite requires an email (employees may have none until then), so `users.email` is always set.
Links go through a `NotificationPort`; a person other than a Super Admin never receives a link in an API response, because a
manager who could read an employee's reset link could become that employee and inherit permissions the manager lacks.
