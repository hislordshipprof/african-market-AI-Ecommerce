# 6. Delivery options, courier selection and fees

Date: 2026-10-30 · Status: accepted · Refines spec D3, D4, D6 and open question 8

At checkout the customer sees up to three **fulfillment options**: **Store delivery** (only if the store delivers itself, at a fee the store sets), **Courier delivery**, and **Pickup**. For Courier delivery the customer does *not* choose the company. The platform requests quotes and dispatches whichever of Uber Direct or DoorDash Drive is cheaper and available, shows the brand ("Delivered by Uber", which Uber's terms require), and fails over to the other provider if no driver is assigned. The customer pays the **real courier quote with no markup**, itemized. A store may absorb it above a free-delivery threshold.

Courier eligibility keeps the **50 lb rule** (no single item over 50 lb and no order over 50 lb in total). It is a platform setting, to be raised once a provider confirms multi-package grocery limits in writing. Uber's terms say 50 lb *per package*, while DoorDash Drive's limit is unverified. Orders that aren't eligible get Store delivery or Pickup.

Considered: letting the customer pick Uber vs DoorDash (rejected: failover would need a second customer decision); Roadie for heavy orders (deferred: a third integration); Bolt (not available in the US).
