# Bug classes

Many symptoms fit a known class, and the class says where to look first. Match the symptom against this list before you rank hypotheses; a match becomes a hypothesis like any other, with its own prediction.

- **Time and timezone:** off by hours near midnight, failures during DST changes, seconds vs milliseconds, naive and timezone-aware datetimes mixed, UTC assumed where local is used.
- **Encoding and locale:** garbled characters, byte length vs character length off by one, a BOM that breaks a parser, missing non-ASCII characters, locale-sensitive comparisons.
- **Floating point:** values that should be equal and are not, NaN spreading silently through a calculation, precision lost at the extremes of the range.
- **Integer overflow:** wraparound on bounded types, negative values where only non-negative ones were expected.
- **Off-by-one and boundaries:** the empty collection, the first or last element missing, inclusive vs exclusive ranges.
- **Cache staleness:** correct after a change, wrong some time later, fixed by a restart or a flush. HTTP and CDN caches, memoization, service workers.
- **Permissions and auth:** works for one user and not another, works without the auth layer in dev, works as superuser but not as the real identity.
- **Dependency drift:** works on one machine and not another, lockfile out of sync with the manifest, a transitive update, a native module built for another runtime.
- **Path and case:** works on macOS and fails on Linux (case), works on Linux and fails on Windows (separators, reserved names such as `CON`).
- **Concurrency and ordering:** passes in serial and fails in parallel, or fails only in some randomized orders.
- **Sequential state overwrite:** setting one field works alone, but a later setter or reset replaces the whole state and removes it. For example, setting a city followed by a country setter that builds `{ country }` loses the city without any race. Replay the complete user action sequence and assert all required fields in the final state, not only each setter's immediate result.
- **TOCTOU:** a check passed, then the state changed before the action that depended on it.
- **Test pollution:** a test passes alone and fails in the suite, or the suite leaves files or state behind. Run the test files one at a time and check the state after each to find the polluter.
- **Timing guesses:** a fixed sleep before an assert, passing locally and failing under load or in CI. The fix waits for the actual condition, with a timeout.
