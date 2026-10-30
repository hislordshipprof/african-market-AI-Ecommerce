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
