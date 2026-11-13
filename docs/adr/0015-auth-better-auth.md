# 15. Sign-in with Better Auth

Date: 2026-10-30 · Status: accepted

## Context
There are three kinds of user: customers (one platform-wide account plus guest checkout, ADR-0002), store owners and staff (roles per store), and platform admins. Shoppers are phone-first and WhatsApp-native. The target is about 1M customer accounts (ADR-0012).

## Decision
Use **Better Auth**, which is open source, runs inside our app and stores users in our Postgres:
- Customers sign in with a **phone one-time code** (email as an alternative).
- Stores and staff use the **organization plugin** with roles. Owners and staff must use **2FA** (spec §15).
- Its built-in **rate limiter** (stored in Postgres) protects code sends from SMS-pumping fraud.

Not chosen: Clerk (per-user pricing gets expensive at 1M customers, and user data lives outside our database) and Auth.js (we'd build phone codes, organizations and 2FA ourselves).

## Consequences
- No per-user fee as customers grow. We own security patching, so track Better Auth releases.
- Sessions are cookies scoped to each store's domain. A customer's account works across stores, but each store's site needs its own sign-in hop.
- Every SMS code costs money, so cap sends per phone number and per IP, and block premium-rate number ranges.

## Account recovery (#395, 2026-11-13)
Staff and platform admins sign in with a password and an authenticator code. Recovery uses the account email, because email is already every account's sign-in channel and phone codes wait for #190:
- **Lost phone:** ten single-use **backup codes**, shown once right after 2FA setup. The second sign-in step takes one in place of the 6-digit code.
- **Forgotten password:** an emailed reset link (1 hour). A reset ends every session and never skips the authenticator step.
- **Lost both:** no self-service path around both factors. An operator resets the account out of band; there is no tool for that yet (`pnpm admin:create` refuses an existing email).
- Trusted-device cookies are never issued: they skipped the second step without marking the session verified.
- Magic-link sends are capped per IP (5 a minute) and per inbox (5 mailed links in 10 minutes; a blocked send leaves no row), so rotating IPs cannot flood one inbox or keep it without a live link.
- A shopper who only ever used a magic link has no password; a staff invite (mailed to that address) adds one, and never replaces an existing one.

Admins who set up 2FA before this change never saw their backup codes. They regenerate them with their password (`/two-factor/generate-backup-codes`) until a settings screen exists.
