# When to Mock

Mock at **system boundaries** only:

- External APIs (payment, email, etc.)
- Databases (sometimes: prefer a test DB)
- Time/randomness
- File system (sometimes)

Don't mock:

- Your own classes/modules
- Internal collaborators
- Anything you control

One exception: an in-memory adapter at a real port to a service you own across a network boundary (the Ports & Adapters case in the `codebase-design` skill's deepening reference). It is a second implementation of the port, not a mock of your own internals.

## Designing for Mockability

At system boundaries, design interfaces that are easy to mock:

**1. Use dependency injection**

Pass external dependencies in rather than creating them internally:

```typescript
// Easy to mock
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// Hard to mock
function processPayment(order) {
  const client = new StripeClient();
  return client.charge(order.total);
}
```

**2. Prefer SDK-style interfaces over generic fetchers**

Create specific functions for each external operation instead of one generic function with conditional logic:

```typescript
// GOOD: Each function is independently mockable
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  getOrders: (userId) => fetch(`/users/${userId}/orders`),
  createOrder: (data) => fetch('/orders', { method: 'POST', body: data }),
};

// BAD: Mocking requires conditional logic inside the mock
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
};
```

The SDK approach means:
- Each mock returns one specific shape
- No conditional logic in test setup
- Easier to see which endpoints a test exercises
- Type safety per endpoint

## Keeping Mocks Honest

- **Assert on the real code.** An assertion on the mock itself passes whenever the mock exists. Assert on what the real code does.

  ```typescript
  // BAD: passes as long as the mock renders
  expect(screen.getByTestId("sidebar-mock")).toBeInTheDocument();

  // GOOD: checks what the real page renders
  expect(screen.getByRole("navigation")).toBeInTheDocument();
  ```

- **Learn the side effects first.** Before you replace a method, list what it does. Keep real the effects the test depends on, and mock the slow or external call below them.
- **Mirror the full shape.** A mock response carries every field the real one has, not only the fields this test reads. Code that reads a missing field passes the test and breaks in production.
- **Keep test-only code in test utilities.** A cleanup or reset method that only tests call belongs in a test helper, and the production class keeps only production methods.
- **Big setup means real components.** When mock setup outgrows the test, use the real components and test at a higher seam.
