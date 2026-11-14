# Characterization Tests

A characterization test records what code does now, right or wrong. Write them before you change code that has no tests. A change that alters behavior then fails loudly. When tests already cover the code, they are the characterization tests: go straight to "When you have enough".

## Find the expected value

1. Call the code at the seam the change goes through, with a realistic input.
2. Assert a value you know is wrong.
3. Run the test. Copy the actual value from the failure message into the assertion.

Repeat for each input that takes a different branch. Include the ugly inputs: empty, zero, negative, null, the boundary, the duplicate. Errors are behavior too, so pin the error type and message that callers see.

Here the expected value comes from the code, which the **Tautological** anti-pattern forbids elsewhere. The difference: a characterization test claims only that behavior stays the same, never that it is right.

## When a pinned value is wrong

Keep it pinned. Add a comment that says it is wrong. Fix it in a separate change, after the refactor lands, because callers may depend on it.

## When you have enough

Break the code you are about to change, on purpose, once for each refactor step. At least one test must go red. Undo the break. If nothing went red, the tests do not cover the change yet. A pure move of code is checked by diffing the moved lines instead.

Fix or quarantine a flaky test before you start. A red run you have learned to ignore tells you nothing.
