# Review Dimension Catalog

Reference catalog of review dimensions organized by category. Each row maps a
project evidence signal to a dimension name and default severity. Only propose a
dimension when the corresponding evidence is found during the Step 1 scan.

## Core Dimensions (technical)

| Evidence found | Dimension | Severity | Model |
| --- | --- | --- | --- |
| Auth dirs, JWT/OAuth/session deps | `security-review` | high | `gemini-4-neon-medium` |
| ORM deps, migration files, SQL dirs | `data-integrity-review` | high | `gemini-4-neon-low` |
| Route/controller/handler dirs, API route definitions | `api-review` | high | `gemini-4-neon-low` |
| Queue libs, worker dirs, async patterns, thread pools | `concurrency-review` | high | `gemini-4-argon-medium` |
| Cache libs (Redis, Memcached), service/repo layers | `performance-review` | medium | `gemini-4-hydrogen-medium` |
| Test files present (`*.test.*`, `*.spec.*`) | `test-coverage-review` | medium | `gemini-4-hydrogen-medium` |
| Multiple `.md` files, `docs/` directory | `documentation-review` | low | `gemini-4-hydrogen-medium` |
| Docker, k8s, Terraform, CI/CD files | `infrastructure-review` | medium | `gemini-4-hydrogen-medium` |
| UI components, CSS/SCSS, template files | `ui-review` | medium | `gemini-4-hydrogen-medium` |
| Any project (always include) | `code-quality-review` | medium | `gemini-4-hydrogen-medium` |

## Extended Dimensions (non-technical and cross-cutting)

| Evidence found | Dimension | Severity | Model |
| --- | --- | --- | --- |
| Mixed casing styles across files, ESLint naming rules configured | `naming-conventions-review` | low | `gemini-4-hydrogen-medium` |
| JSDoc/docstring config, CHANGELOG.md, README quality signals | `documentation-quality-review` | low | `gemini-4-hydrogen-medium` |
| `.github/workflows/`, `.circleci/`, `Jenkinsfile`, CI config | `ci-cd-pipeline-review` | medium | `gemini-4-hydrogen-medium` |
| OpenAPI/Swagger/GraphQL schemas (`*.graphql`, `openapi.*`), `*.proto` files | `api-contract-review` | high | `gemini-4-argon-low` |
| Lock files (`package-lock.json`, `yarn.lock`, `poetry.lock`), `.npmrc`, license-checking deps | `dependency-management-review` | medium | `gemini-4-hydrogen-medium` |
| `.env*` files, `config/` directory, feature flag libs (LaunchDarkly, Unleash, ConfigCat) | `configuration-management-review` | medium | `gemini-4-hydrogen-medium` |
| Error boundary files, custom error classes, retry/circuit-breaker patterns | `error-handling-review` | medium | `gemini-4-hydrogen-medium` |
| UI components + a11y testing deps (`jest-axe`, `@axe-core/*`, `@testing-library/jest-axe`) | `accessibility-review` | medium | `gemini-4-hydrogen-medium` |
| `i18n/`, `locales/`, `translations/` dirs, i18n lib deps (`i18next`, `react-intl`, `vue-i18n`) | `internationalization-review` | low | `gemini-4-hydrogen-medium` |
| `migrations/` dir, Prisma/Alembic/Flyway/Liquibase files, `*.sql` migration scripts | `database-migrations-review` | high | `gemini-4-neon-low` |
| Structured logging libs (`winston`, `pino`, `structlog`), OpenTelemetry deps | `logging-observability-review` | medium | `gemini-4-hydrogen-medium` |
| `tsconfig.json` with `strict: true`, `.d.ts` files present | `type-safety-review` | medium | `gemini-4-hydrogen-medium` |
| Redux/Zustand/Vuex/MobX/Pinia deps, `store/` or `state/` dirs | `state-management-review` | medium | `gemini-4-hydrogen-medium` |
| `bin/` dir, `commander`/`yargs`/`meow`/`clap`/`cobra` deps | `cli-ux-review` | medium | `gemini-4-hydrogen-medium` |
| `openspec/config.yaml` present, `openspec/changes/*/specs/*.md` delta spec files | `spec-compliance-review` | high | `gemini-4-argon-medium` |

## Project-type Dimensions (conditional on project structure)

| Evidence found | Dimension | Severity | Model |
| --- | --- | --- | --- |
| `packages/`/`apps/` dirs + workspace config (`lerna.json`, `pnpm-workspace.yaml`, `nx.json`, or `workspaces` in package.json) | `monorepo-governance-review` | medium | `gemini-4-hydrogen-medium` |
| `plugins/` or `extensions/` dirs + manifest files (`plugin.json`, `manifest.json`) or hook registration patterns | `plugin-architecture-review` | medium | `gemini-4-hydrogen-high` |
| Package exports, `index.ts`/`index.js` barrel files, semver in package.json, `CHANGELOG.md` | `sdk-library-design-review` | high | `gemini-4-hydrogen-high` |
| `android/`/`ios/` dirs, React Native/Flutter/Capacitor deps | `mobile-app-review` | medium | `gemini-4-hydrogen-medium` |
| DAG definitions, ETL scripts, `pipeline/` dirs, Spark/Airflow/Dagster deps | `data-pipeline-review` | high | `gemini-4-hydrogen-high` |
| Model files, `training/` dirs, ML libs (torch, tensorflow, sklearn) in requirements | `ml-ai-review` | medium | `gemini-4-hydrogen-medium` |
| Docker Compose with multiple services, `services/` dir, API gateway config, contract test files | `microservices-review` | medium | `gemini-4-hydrogen-high` |
