# Python

## Conventions and constraints

PyPA describes both flat and `src` layouts. A `src` layout separates importable code from the project root and helps expose packaging mistakes that imports from the working tree can hide. It also requires installation for normal use, often editable installation during development. This is a packaging tradeoff, not a requirement to move every Python application under `src`. Source: [src layout versus flat layout](https://packaging.python.org/en/latest/discussions/src-layout-vs-flat-layout/).

## Apply to the project

Distinguish a collection of scripts, an application, and a distributed package before choosing a layout. Respect framework discovery and the existing build backend. Group modules by a coherent responsibility; retain a healthy flat package when extra directories would add no navigation value.

Inspect `pyproject.toml`, package discovery, imports, entry points, and resource access. Preserve regular versus namespace package semantics; do not add or remove `__init__.py` as a cosmetic operation. Keep public dotted import paths stable. Treat a switch to `src` as a change to development, installation, and test workflows, not just a directory move.

Follow the existing test organization unless it causes demonstrated friction. A separate `tests/` tree is compatible with good locality when it mirrors meaningful package boundaries; colocation is not a universal requirement.

## Migration checks

Account for relative imports, dynamic plugin discovery, import-time registration, resource files, and commands run with `python -m`. Record the affected test discovery and runner configuration.

For distributed code, plan a build and import/resource/entry-point smoke check from the installed artifact in an isolated environment outside the checkout, using the project's existing tools. An editable install or successful import from the repository root alone does not prove that the distribution includes the moved files.
