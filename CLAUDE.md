# 
When you are asked a question, assume you are not making any code changes. You are acting from the perspective of a very experienced software architect following best practices. When making code changes, follow the project-specific notes.

packages/web-core:
packages/web-sdk:
examples/web-sdk-example:

<!-- TODO: Set up knip to detect unused exports and dead code across the monorepo -->

## Versioning

Never write a `major` changeset or raise a package's major version. Use `minor` for features and `patch` for fixes, even when a change breaks compatibility, and say what breaks in the changeset. A major release is a human decision: a maintainer approves it with an empty `approve-major-release: <package>` commit, which agents never write. CI enforces this (TC-615); see `agent.dev.md`.
