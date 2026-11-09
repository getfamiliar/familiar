---
categories: [banking, security]
---
# Nordbank pushTAN incident

Unexpected pushTAN request to activate a new device at Nordbank in August 2026; not confirmed, access secured.

## Sequence

- **2026-08-03, 21:47**: the pushTAN app shows a request "Register new device" — Jürgen had not triggered anything
- Request **not confirmed** but rejected
- **2026-08-03, 21:55**: call to Nordbank's blocking hotline — online banking blocked as a precaution
- **2026-08-04**: call back from Nordbank's security team: login with the correct password from abroad, presumably a password from a data leak
- **2026-08-04**: foreign device unlinked, **password changed**, online banking unblocked
- **2026-08-05**: all transactions checked — no unauthorized payments

## Consequences

- Password manager set up for all banking logins, new passwords generated
- Nordbank logins noted in [[self/services]] with the date of the change
- Phishing patterns added to [[threads/phishing-patterns]]

## Addenda

- **2026-08-12**: letter from Nordbank confirming the block and unblock — filed
- **2026-08-12**: Addendum: the same notification also delivered by email, no action
