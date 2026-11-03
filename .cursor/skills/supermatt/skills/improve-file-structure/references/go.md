# Go

## Conventions and constraints

A small Go package or command can keep several files in one directory. Each package has its own directory; moving a file into a subdirectory can create a different package, not just a visual grouping. The official guide recommends `internal` for implementation packages and describes `cmd` as a convention for commands, especially in mixed projects. These are not reasons to impose a large starter tree on a small module. Source: [Organizing a Go module](https://go.dev/doc/modules/layout).

Package names should describe their purpose; generic names such as `util`, `common`, or `misc` obscure ownership. Source: [Package names](https://go.dev/blog/package-names).

Imports cannot form cycles, and cross-package access depends on exported identifiers. A move that needs new exports or dependency redesign exceeds a purely mechanical relocation. Source: [Go specification](https://go.dev/ref/spec#Import_declarations).

## Apply to the project

Preserve cohesive flat packages even when they contain many files. Recommend a new directory only for a coherent package with an explainable dependency relationship. Trace callers and unexported identifiers before labeling a move safe; route required interface redesign to architecture work.

Distinguish public packages from implementation packages. Check whether moving a package under `internal` would make an existing caller ineligible to import it. Keep existing module paths and public package paths unless the user chooses a compatibility change. Do not introduce a new module or a `pkg` directory by default.

## Migration checks

Inspect package declarations, imports, external versus same-package tests, build tags, generated files, embed paths, and `testdata` use. Plan affected package tests and the repository's full Go gate, commonly `go test ./...`, plus builds of affected commands. Check supported build configurations when tagged files move. A source search alone does not verify resource loading or external consumers.
