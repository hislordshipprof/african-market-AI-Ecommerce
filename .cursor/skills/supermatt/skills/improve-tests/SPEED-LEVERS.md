# Speed levers

Timing commands for Step 1 and the levers that recover time for Step 3. Flags change between versions: confirm each one against the installed runner's `--help` or docs before you use it.

## Measure

Split the run into phases before judging tests: boot (framework load, transpile), import (loading test files and what they import), setup (fixtures, factories, `before` blocks), and test bodies. A run dominated by boot or import gains little from deleting tests. A run dominated by setup gains most from levers 1 and 2.

Without a profiler, time a suspect directly. Load a one-line override with the runner (`rspec -r ./tmp/quiet.rb` holding `Rails.logger.level = :fatal`) and run the same slice both ways, or prepend a module that times one method and writes the sum from the runner's after-all hook (`bun test` drops output printed at process exit). A sampler thread reading another thread's backtrace sees only calls that release the GVL (IO, database), so it over-reports them. A CPU profile shows no waits: to find them, wrap `sleep` and `setTimeout` in a preload and sum the requested delay per call site.

| Runner | Slowest tests | Phases |
|---|---|---|
| RSpec | `rspec --profile 20` | test-prof: `TEST_STACK_PROF=boot rspec <one spec>` for boot, `RD_PROF=1` for `let`/`before` time against the example body, `TAG_PROF=type` for time per spec type |
| Minitest, Rails | `bin/rails test --profile 20` (Rails 7.1+), `-v` for every test with its time | test-prof as above; Minitest 6 needs `Minitest.load :test_prof` in the test helper |
| Vitest | `--reporter=verbose`, `slowTestThreshold` | The summary line splits transform, setup, import, tests, environment. `--experimental.importDurations.print` lists the slowest imports. `vitest doctor` reruns under candidate configs and reports the measured difference. |
| Bun | Per-test times print inline | `bun test --timings=<file> --update-timings` writes per-file wall time, slowest first |
| Jest | `--verbose`, `--json --outputFile=<file>` | Reporter `perfStats` holds environment and setup times |
| pytest | `--durations=20` (setup, call, and teardown on separate rows) | `--collect-only` times collection; `python -X importtime` finds slow imports |
| Go | `go test -json ./...` (`Elapsed` per test and package) | `-count=1` bypasses the result cache; `-cpuprofile` |
| Playwright | `reportSlowTests` in config | |

For Ruby, test-prof holds most of the profilers: `EVENT_PROF=factory.create` or `EVENT_PROF=sql.active_record` for time spent in those events, `FPROF=1` for factory counts (a factory used more times than there are examples means cascades), `FDOC=1` for records created and never needed. It is a gem: if the project lacks it, propose it (Guardrail 5).

## Levers

Ordered by how often each is the top finding. The payoffs are the ones the sources report.

| # | Lever | Detect | Fix | Risk |
|---|---|---|---|---|
| 1 | **Database writes and factory cascades** | `EVENT_PROF=factory.create` share, `FPROF`, `FDOC` | `build` or `build_stubbed` where the test does not need a saved record (associations follow the parent's strategy); `create_default` for a shared parent. Evil Martians report factories as most of a slow Rails suite's time, 85% in one example. | Stubbed records skip constraints, callbacks, and uniqueness: keep `create` where persistence is the claim. |
| 2 | **Per-test setup that could run once** | `RD_PROF=1`, pytest setup rows, Vitest setup phase | `let_it_be` or `before_all` (test-prof), pytest fixture `scope="module"`, Playwright `storageState` to log in once. test-prof cites GitLab at 39% saved on API tests and Discourse at about 27%. | State leaks between tests: use `refind: true` or `freeze: true`, and run in random order. |
| 3 | **Password hashing cost** | `*crypt*` near the top of a sampled profile | Minimum cost in the test env. Rails `has_secure_password` already does it; Devise needs `config.stretches = Rails.env.test? ? 1 : 12`; check any other library by hand. | None. |
| 4 | **Background jobs run inline** | `EVENT_PROF=sidekiq.inline` | Fake mode by default; inline only the tests that need job side effects. | Tests that relied on the side effects need the tag. |
| 5 | **Browser, system, or e2e tests over logic** | Time by test type; system files top the slow list | Demote (Step 3). The Rails guide reserves system tests for critical user paths. | UI wiring loses cover: keep one happy path per critical flow. |
| 6 | **Heavy rendering** | Renderer frames in the profile; tests calling PDF, image, spreadsheet, or chart libraries | **Rendered Output Test** (Step 3) where the claim is the data. Where tests render only as setup, fake the library's own entry point by default in the test helper and tag the real smokes in, so our adapter and every hook on it still run. | None while the adapter smokes stay tagged real. |
| 7 | **Real network** | Socket frames in the profile; tests slow or failing offline | The project's HTTP stubbing library with real connections blocked (WebMock `disable_net_connect!(allow_localhost: true)`), or a fake adapter. | API drift: keep one contract or recorded test per API. |
| 8 | **Sleeps and real timers** | Slow tests with near-zero CPU; `sleep`, `setTimeout`, `waitForTimeout` in tests, or a fixed poll interval in the production code a test drives | Poll for the condition. Fake time: `vi.useFakeTimers`, `jest.useFakeTimers`, Bun `setSystemTime`, Go `testing/synctest`, Rails `travel_to` and `freeze_time`. A production poll interval becomes a parameter the test sets short. | Fake timers can hide ordering bugs. |
| 9 | **JS environment and isolation cost** | Large import, environment, or worker phase | `environment: 'node'` for tests that touch no DOM; happy-dom where a DOM is needed and jsdom is not required. Vitest `isolate: false` or `pool: 'threads'` (validate with shuffled files, which `vitest doctor` does); Bun `--parallel --no-isolate`. Vitest docs put jsdom at about 200-500 ms per file under isolation. | State leaks between files. |
| 10 | **Parallelism off or unbalanced** | CPU mostly idle during the run; one worker | Rails `parallelize(workers: :number_of_processors)`, parallel_tests grouped by runtime, `pytest -n auto`, Go `t.Parallel()`, Playwright `fullyParallel`, Bun `--parallel`. | Shared database, ports, temp dirs: per-worker ids and a random-order run. |
| 11 | **Import and transform cost** | Slow imports in the phase report | Import from the module, not a barrel file; `NODE_COMPILE_CACHE`; Vitest `fsModuleCache`. | None. |
| 12 | **Boot** | `TEST_STACK_PROF=boot`, time of a one-test run | Bootsnap; `eager_load` on only in CI, as the Rails template sets it. | Without eager load, load errors show only in CI. |
| 13 | **Database cleanup** | Truncation or deletion strategy for every test | Transactional tests; truncation only where another process reads the data (browser tests). | Code that manages its own transactions needs truncation. |
| 14 | **Logging and coverage on every run** | Log writes or coverage instrumentation in the profile | Test logger at `:fatal` or to null; coverage behind an env var. | None. |
| 15 | **Side effects of setup** | Count the calls to callbacks, event subscribers, and broadcasts during a run | Mute the subscriber only inside the seeding helper; the code under test still fires it. | An example that used setup's side effect as its arrange: make that step explicit. |

## Tiers and CI

Apply these after the cuts: a tier hides slow tests from the local run, and it is no place for tests nobody would miss.

- **Tiers.** The default local run is the fast suite. The slow tier (browser, e2e) runs on every pull request in CI and on demand locally. Tag tests by level so each tier is one command.
- **Changed-only local runs.** `vitest related` or `--changed`, `jest --findRelatedTests` or `--onlyChanged`, `bun test --changed`, `playwright test --only-changed`, `nx affected`. They miss config changes and dynamic imports, so CI still runs everything.
- **Split CI by timing.** parallel_tests `--group-by runtime`, Bun `--shard` with `--timings`, Playwright `--shard` with `fullyParallel`. Vitest and Jest `--shard` split by file count, not time.
