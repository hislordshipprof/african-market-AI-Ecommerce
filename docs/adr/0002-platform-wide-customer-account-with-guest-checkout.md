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
