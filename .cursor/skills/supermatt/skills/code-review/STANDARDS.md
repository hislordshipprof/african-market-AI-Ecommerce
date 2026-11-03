# Standards baseline

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation.

Each smell reads _what it is_ → _how to fix_; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change, or a new hunk repeats logic that a function outside the diff already computes (search the codebase for it by what it computes). Report how many copies the codebase holds in total, not only those in the diff, since that count decides whether an extraction pays. → extract the shared shape, or call the existing function.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

The Standards axis also carries one **refactor check**, a hard finding. A commit that its message marks as a refactor (`refactor:` in Conventional Commits) must not change an assertion's expected value for a behavior the commit still exposes. Such a change altered behavior under a refactor label, or rewrote a test to match the new code. A test deleted because the commit removed its subject or made it private passes, and so does one moved into boundary tests of the new interface.

It also carries a **test check**, a judgement call:

- **Untested behavior**: the diff changes runtime behavior (a new branch, a state change, an error path, a changed contract) and no test in the diff exercises it.
- **Vacuous test**: a new or changed test would still pass with the code under test broken. It asserts only that nothing throws or that a value is truthy, computes its expected value with the code under test, or has a mock supply the result the code should produce.
- **Flaky test**: a new or changed test depends on time, randomness, test order, or shared state it does not reset.
- **Mirror test**: a test asserts on its own copy of what the source does (the steps a script runs, the fields a schema holds) and never exercises the source, so the source can change while the test still passes.

Trivial accessors and edits that change no behavior pass.
