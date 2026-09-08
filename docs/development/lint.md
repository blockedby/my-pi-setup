# Linting

Run `bun run install:dependencies`, then `bun run lint` from the repository root.
The lint command only reports diagnostics; it does not modify files.

Oxlint checks first-party JavaScript and TypeScript with the `correctness`
category treated as errors. Vendor code, dependency directories, build output,
coverage output, and downloaded executables are excluded in `.oxlintrc.json`.
See the [Oxlint configuration documentation](https://oxc.rs/docs/guide/usage/linter/config).

Intentional control-character sanitization and listener snapshots carry narrow,
explained rule suppressions so lint cleanup preserves their behavior.
Lint remains a separate command; adding it to the upgrade verification chain
is a separate integration step.
