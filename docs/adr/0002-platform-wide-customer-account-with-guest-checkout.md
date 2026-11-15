# 2. One customer account across stores, plus guest checkout

Date: 2026-10-30 · Status: accepted

## Context
A customer may buy from several stores on the platform. Small stores' customers often arrive from a WhatsApp link and won't create an account just to place a first order.

## Decision
- A **customer account** is platform-wide: one login works at every store, and saved addresses and payment methods carry over.
- Each store sees only its own customers, their orders, and their marketing consent. One store can never see that a customer buys from another.
- **Guest checkout** is allowed: name, email and phone, no password. A guest can later claim their past orders by creating an account with the same email or phone.

## Consequences
- `User` is platform-scoped and `Customer` is the per-store relationship (spec §13), which guest checkout also creates.
- Phone is required at checkout, because shortage prompts and tracking go by SMS.
- The Phase 2 combined marketplace needs no account merge.

## Note, 2026-11-07 (#70)
Claiming needs a **verified** email (`User.emailVerified`), not only an account with that address: `/sign-up/email` can create a user carrying someone else's email. Matching is on email only, at the same store. Phone matching is deferred to #190.

A claim links the guest `Customer` row to the account's `Customer` at that store (`claimedByCustomerId`). `Order.customerId` does not move, because the name and phone an order was placed with live on the guest row.

This relies on Better Auth 1.7.14 stripping unproven passwords and sessions when a magic link verifies, and is safe except for one race: `revokeUnprovenAccountAccess` deletes accounts, then sessions, then sets `emailVerified`. A password sign-in that read the credential before the delete and creates its session after the session delete keeps that session. The window is milliseconds and needs the attacker to know when the victim clicks. `better-auth` is pinned exactly: a version change, or enabling `user.changeEmail`, must re-check this.
