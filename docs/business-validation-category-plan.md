# Business Validation Category Plan

## 1. Functional Goal
- Create a new automatic review category named `business_logic`.
- When a PR has business-context signals (internal link, ticket, requirement text), automatically trigger business rules validation.
- Publish the result as PR-level review feedback without requiring the manual command.

## 2. Technical Scope
- Reuse existing `BusinessRulesValidationAgentUseCase`.
- Integrate in PR-level pipeline flow (same level as `cross_file` and PR-level checks), not in manual comment command flow.
- Control execution through `reviewOptions.business_logic`.

## 3. Contracts and Configuration
- Add `business_logic` in:
  - `reviewOptions` types/DTOs/schema/default config.
  - code review automation labels (v2 and shared label catalog used by UI).
- Preset behavior:
  - `speed`: disabled.
  - `safety` and `coach`: enabled.
- Keep manual command `@kody -v business-logic` unchanged.

## 4. Trigger Rules and Guardrails
- Run only if `reviewOptions.business_logic = true`.
- Run only if at least one signal is present:
  - task/context link,
  - ticket key like `ABC-123`,
  - requirement/acceptance criteria text in PR content.
- Noise control:
  - do not publish PR-level feedback when result is fully compliant (no gaps),
  - avoid duplicate runs in the same cycle without new context.

## 5. Pipeline Integration
- Add a PR-level stage (e.g. `BusinessLogicValidationStage`).
- Stage inputs:
  - PR number, repository, PR description/body, detected links, detected ticket keys, org/team context.
- Stage execution:
  - call `BusinessRulesValidationAgentUseCase`.
- Stage output:
  - create PR-level suggestion labeled `business_logic` only when there is a meaningful business gap.

## 6. Persistence and UX
- Persist as PR-level suggestion in the same flow used by existing PR-level feedback.
- Ensure UI recognizes and displays `business_logic` badge/filter.
- Update category mapping fallbacks (CLI/export/read models) to avoid unknown-category regressions.

## 7. Observability
- Add logs for:
  - trigger reason,
  - detected signals,
  - agent runtime,
  - result status (`no_gap`, `gap_found`, `error`).
- Add metrics:
  - trigger rate per PR,
  - gap-found rate,
  - error rate,
  - noise ratio (feedback with no actionable gap).

## 8. Test Plan
- Unit tests for stage:
  - disabled option -> no trigger,
  - enabled but no signal -> no trigger,
  - enabled with valid signal -> triggers agent,
  - compliant response -> no PR-level suggestion,
  - gap response -> PR-level suggestion created,
  - agent error -> pipeline continues and records stage error.
- Regression checks:
  - existing `cross_file` and other PR-level behavior remains unchanged.

## 9. Rollout Strategy
- Phase 1: behind feature flag per org/team/repository.
- Phase 2: pilot rollout for selected teams.
- Phase 3: default enable for v2 after signal quality/noise validation.

## 10. Definition of Done
- Category appears in settings/labels with expected behavior.
- Auto-trigger runs only under defined rules.
- PR-level feedback is generated only for real business-rule gaps.
- No regression in existing automatic and manual review flows.
