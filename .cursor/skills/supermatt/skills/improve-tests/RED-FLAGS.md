# Test red flags

Named diagnostics for Step 3. Use the names verbatim in findings and batches. Each flag sits under the move it calls for. Check the "Not a flag when" column before recording one.

## Delete

| Flag | Signal | Not a flag when |
|---|---|---|
| **Library Test** | Asserts what a library or framework guarantees: ORM validation mechanics, route helpers, serializer format, that an email field rejects non-emails, HTTP client encoding. | It drives our declared rule through our own entry point (a request that must reject a blank email), or it is the one smoke test for our adapter. |
| **Trivial Code Test** | Getter, setter, constructor, plain delegation, a constant or config value compared to a literal, a type or shape check with no logic behind it. | The value is a contract read across a process boundary: a public API constant, a wire format field. |
| **Change Detector** | Mocks every collaborator and asserts the calls in order (`expect(x).to receive`, `toHaveBeenCalledWith`, `verify`). It restates the implementation, so it fails on any edit and catches no bug. | The call is the behavior: a card charged once, one email sent, a cache hit that skips a call. |
| **Tautology** | Asserts the value a stub was told to return; computes the expected value with the code under test; asserts only `toBeDefined`, `not_nil`, or `be_truthy`. | |
| **Assertion-Free** | No assertion. It passes whenever the code does not raise. | It is the only test that runs that path: Rewrite it with a real assertion. |
| **Coverage Padding** | Touches lines and asserts nothing about the outcome: logging, debug output, error branches run for the percentage. | |
| **Dead Test** | Skipped or pending (`skip`, `xit`, `.skip`, `pending`, `t.Skip`) with no recent change, or aimed at code that no longer exists. | The skip links an open issue the user wants kept. |
| **Redundant Claim** | Another test at the same or a cheaper level asserts the same claim and fails on the same break. | The two check different outputs of the same code: a value and an emitted event. |

## Demote

Write the claim at the cheaper level, then remove the high-level check. What only the high level catches stays.

| Flag | Signal | Not a flag when |
|---|---|---|
| **Rendered Output Test** | Runs the real renderer (PDF, image, spreadsheet, chart, full email HTML) and inspects the output to check our data: text pulled from a PDF, pixels, a golden binary. Move: extract the data builder, assert on its output, keep one adapter smoke test. | It is that one adapter smoke test. |
| **Logic Through the UI** | A browser, system, or controller test checks a calculation, validation rule, or format that lives in a model or function. | The claim is the UI itself: the flow completes, the element responds, JavaScript behavior with no lower seam. |
| **Same Claim, Several Levels** | The same input and expected value appear in a unit test and again in a request, system, or e2e test. | The higher test also checks wiring the lower one cannot see: strip the duplicate assertion, keep the wiring check. |
| **Slow Component Usage** | A logic test writes to the database, file system, or a subprocess to set up, and reads it back to verify. | The claim is the persistence itself: a query, a constraint, a transaction, a migration. |

## Merge

| Flag | Signal | Not a flag when |
|---|---|---|
| **Near-Duplicate** | Several tests share arrange and act, with one input varying. Move: one parameterized or table-driven test. | They check different outputs. |

## Rewrite

| Flag | Signal | Move |
|---|---|---|
| **Over-Mocked** | Mocks more than one or two collaborators, or mocks our own app's classes; breaks on a refactor that keeps behavior. | Assert on output or state with real collaborators or fakes. Mocks stay only for what others observe: email, third-party APIs, queues. |
| **Mocked Type You Don't Own** | Mocks a third-party class or module directly (`jest.mock('axios')`, an SDK client double). | Wrap the library in our own adapter, test the adapter once against the real library, fake or mock the adapter elsewhere. Exception: renderer stubs used only for unrelated setup may fake the library entry point while application adapter hooks stay active and tagged adapter smoke tests use the real library (speed lever 6 in `SPEED-LEVERS.md`). |
| **Private Method Test** | Reaches past the public API: `send(:private_method)`, `instance_variable_get`, `@VisibleForTesting`, helpers exported only for tests. | Test through the public API. Delete if the public tests reach every path. Logic complex enough to want its own tests is a unit to extract. |
| **Snapshot Dump** | Snapshots or golden files of dozens of lines or more, whole pages, or binaries, regenerated instead of read. | Explicit assertions on the fields that matter. A small snapshot a reviewer reads is fine. |
| **Conditional Test Logic** | `if`, loops, or `try` in a test body; expected values computed with production-like logic. | Literal expected values; parameterized cases. |
| **General Fixture** | Setup builds far more than the test reads: one shared `before` block or factory graph for a whole file. | Minimal setup per test. Factory cascades are speed lever 1. |

## Fix flake

| Flag | Signal | Fix |
|---|---|---|
| **Bare Sleep** | `sleep`, `setTimeout`, `waitForTimeout` to wait for async work. | Poll for the condition, or use fake timers. Both are faster too. |
| **Wall Clock** | `Time.now`, `Date.now()`, `datetime.now()` with no frozen or injected clock. | Freeze time or inject the clock. |
| **Interacting Tests** | Passes alone and fails in random order, or the reverse. Shared mutable fixture or global state. | Fresh state per test. Find the pair with the runner's bisect (`rspec --bisect`) or a shuffled run. |
| **Real Network** | Talks to a remote service. | The project's HTTP stubbing library or a fake adapter, plus one contract or recorded test per API. |
| **Shared Resource** | Parallel runs share a file path, port, or database. | Per-worker paths, ports, and databases (worker id env vars). |

A flaky test that cannot be fixed in this session goes to quarantine with a limit (a date or a count), then gets fixed or deleted. A quarantine with no limit is a deletion nobody approved.

## Report only

**Test Logic in Production**: branches on the environment in app code (`Rails.env.test?`, `NODE_ENV === 'test'`, `if TESTING`). The fix is in production code (inject the dependency), so report it and leave it out of the batches.
