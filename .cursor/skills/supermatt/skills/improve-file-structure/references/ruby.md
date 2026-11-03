# Ruby

## Conventions and constraints

RubyGems uses `lib/<gem>.rb` as a loading entry point and `lib/<gem>/` for supporting files. The packaged file list must include those files. Preserve the public `require` surface when reorganizing internals. Source: [Make your own gem](https://guides.rubygems.org/make-your-own-gem/).

Rails autoloading expects file paths to match constants relative to configured autoload roots, subject to inflection rules. For example, `app/models/admin/user.rb` conventionally defines `Admin::User`; a directory move can imply a namespace change. Inspect roots, namespaces, and inflector overrides before proposing it. Source: [Rails autoloading and reloading constants](https://guides.rubyonrails.org/autoloading_and_reloading_constants.html).

## Apply to the project

Distinguish a gem, a plain Ruby app, and a framework-managed application. Respect Rails' established folders; reorganize within its conventions only where evidence supports the change. Do not transplant a TypeScript feature tree over autoload roots.

For plain Ruby, group files around cohesive responsibilities and inspect explicit loading before recommending a namespace-shaped tree. Filesystem nesting alone does not establish a Ruby namespace. Keep test/spec conventions already used by the project.

## Migration checks

Trace `require`, `require_relative`, load paths, autoload/eager-load configuration, gemspec file lists, executable entry points, and assets. Identify whether a proposed move changes any constant path or public require path; resolve that compatibility choice before finalizing.

Plan affected tests and application boot. For Rails using Zeitwerk, include the project's `zeitwerk:check` task when available and the relevant runtime smoke checks. For a gem, verify public requires and resources from the built, installed gem using the existing build tooling. A test that loads only from the checkout can miss packaging failures.
