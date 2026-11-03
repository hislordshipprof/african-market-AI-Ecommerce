# Red Flags

Named signs of a shallow or leaky module. Use these names when you record friction or write up a deepening candidate.

These flags are about module design. Code-level smells (names, duplication, feature envy) belong to the smell baseline in the `code-review` skill.

| Flag | What it looks like |
|---|---|
| **Shallow Module** | The interface costs about as much to learn as the implementation saves. Some modules are shallow by design: thin adapters, data classes with no logic, configuration loaders. |
| **Information Leakage** | One design decision is encoded in two or more modules, such as a file format that both the reader and the writer know. |
| **Back-door Leakage** | Modules share knowledge that appears in no interface. Nothing in the signatures shows it. |
| **Temporal Decomposition** | Modules split by execution order (read, then parse, then write), so the same knowledge sits in several of them. |
| **Overexposure** | The common case makes callers learn rarely used options first. |
| **Pass-Through Method** | A method only forwards its arguments to another method with the same signature. |
| **Special-General Mixture** | Code for one use case sits inside a general mechanism that every caller shares. |
| **Conjoined Methods** | Two methods make sense only when read together. They are one module under two names. |
| **Hard to Describe** | A complete, simple description of the module is hard to write. The difficulty is the finding. |
| **Hard to Pick Name** | No name fits, usually because the module holds two concepts. Split it, and each part names itself. |

## Classitis

Many small, shallow modules add up to a large total interface. Splitting a shallow module further makes this worse. A module with two responsibilities still splits, though.

Length alone is rarely a reason to split. A long function with a small interface and clear internal blocks is deep. Leave it.

## Reading the flags

One flag on one module is noise. A candidate is several flags on the same group of modules.
