# TypeScript and JavaScript

## Conventions and constraints

TypeScript models the runtime or bundler's module rules; validate a move against that host, not only the compiler. A `paths` mapping does not rewrite emitted import specifiers. Read the project's module configuration before proposing aliases or changing extensions. Sources: [module theory](https://www.typescriptlang.org/docs/handbook/modules/theory.html), [module reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html#paths).

Angular recommends feature-area directories and keeping related source, tests, templates, and styles together. This is Angular guidance, not a universal TypeScript layout. It offers useful evidence for feature grouping when a project's current structure scatters related work. Source: [Angular style guide](https://angular.dev/style-guide#project-structure).

Next.js reserves files and directories for routing, while allowing several organization strategies and colocated non-route files. Check the project's router and version before moving route files, layouts, or private folders. Source: [Next.js project structure](https://nextjs.org/docs/app/getting-started/project-structure).

## Apply to the project

- **Applications:** follow framework-controlled entry points and discovery first. Group internal feature files when it reduces the observed navigation cost. For a framework-free app, `src/orders/` can own order logic, types, and tests without introducing `features/`, `services/`, and `repositories/` layers. Treat this as a candidate, not a template.
- **Libraries:** inspect package entry points, exports, type declarations, and published file lists. Preserve supported consumer import paths, including documented deep imports; internal source paths and public paths need not move together.
- **Workspaces:** inspect existing package ownership and build references. Prefer reorganization within a package; a new workspace package needs an independent reason beyond folder tidiness.

Keep local helpers and types with their feature. A shared directory needs actual consumers and a named responsibility. Do not add barrels, aliases, or packages just to shorten imports; examine cycles and runtime side effects before changing re-exports.

## Migration checks

Map static and dynamic imports, re-exports, test mocks/globs, resource URLs, code generation, and path-sensitive scripts. Check compiler include/root/output settings and runtime/bundler resolution together. Preserve server/client boundaries and route URLs when the framework gives location meaning.

Plan the project's typecheck, build, and affected tests, plus a runtime entry-point or route smoke check where discovery is involved. For a published library, verify imports and types from the built package, not only through source aliases. For moved tests, compare discovery before and after without weakening assertions.
