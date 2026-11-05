# 19. Refund requests are a ledger; Stripe is the source of truth

Date: 2026-11-05 · Status: accepted

## Context

Refund retries were stored as untyped audit JSON (`refund_retry` rows with `inFlight`, `refundKey`, and `knownRefundIds`). Each review round released that marker on a different read of Stripe. Releasing it after a connection error let the platform repay money Stripe later refunded. Keeping it forever left a Refund failed order that could not be resolved.

Stripe owns the refund outcome. The app owns the request it sent, including the exact amount and fee flag, so a later read can be matched to that request.

## Decision

- A store-scoped `RefundRequest` row is inserted before `refunds.create` and committed first. Its key is `refund:<orderId>:<seq>`, sent as `metadata.reservation`. `metadata.order_id` is sent as well.
- The row stays open while it is `RESERVED`, `UNKNOWN`, or `CREATED` with a non-terminal provider status. `NOT_CREATED`, `ABANDONED`, and a terminal `CREATED` row are closed.
- A 409, a network error, or a 5xx leaves the row `UNKNOWN`. `charge_already_refunded`, an over-refund, and any other invalid-request 4xx leave it `NOT_CREATED`. A re-read that shows no change does not close the row.
- Reconciliation lists refunds and matches `metadata.reservation`. Inside 23 hours it replays the same key and the stored amount. After 23 hours the row becomes `ABANDONED`, with a platform alert. A refund that arrives later becomes `CREATED`. The 23 hour window is inside Stripe's 24 hour idempotency window.
- Manual repayment is allowed only when nothing is pending and no request is open. The audit records `repaidCents`, `refundedCents`, `capturedCents`, and the counted provider refund ids. It moves no money. Under the store lock the balance is read again, and a change since the snapshot refuses the repayment.
- One locked evaluation decides the order after every ledger change. A Refund failed order whose succeeded refunds cover the capture, with nothing pending and no open request, is cancelled. An uncovered terminal failure with nothing open moves a cancelling or cancelled order to Refund failed. A cancelling order that is already covered stays in the cancellation flow, so a covered failure does not skip it. After manual resolution, that evaluation compares the succeeded total with the stored baseline, alerts the store and the platform when the balance moves, and does not reopen the order. Store audit access is insert and select, so the moving baseline is a new `refund_resolution_baseline` row. A repeated event for the same balance writes no second alert.

The 23 hour abandon rule and the alert-only behavior after manual resolution are coordinator defaults, pending owner confirmation.

## Consequences

- `S + P + U + M` stays at or below the captured amount. `S` is succeeded refunds, `P` is pending, `U` is an open request, and `M` is the manual repayment.
- Staff see "Confirming" while a request is open, and the owed amount only when it is not.
- Capture and cancel keep their own retry keys. Refunds no longer use `alreadyRefundedCents` in the key.
