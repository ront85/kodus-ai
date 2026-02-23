---
name: business-rules-validation
description: Validate PR code changes against task requirements to identify missing, forgotten, or overlooked business logic implementations
allowed-tools:
  - KODUS_GET_PULL_REQUEST
  - KODUS_GET_PULL_REQUEST_DIFF
metadata:
  version: "1.0.0"
---

# Business Rules Gap Analysis

## Goal

Find what is **MISSING**, **FORGOTTEN**, or **OVERLOOKED** — not what is present.
Every validation must be grounded in specific business requirements from the external task.

## Input (pre-fetched in context)

- **TASK_CONTEXT**: Requirements, acceptance criteria, and business rules from the external task management system (Jira, Notion, Linear, etc.)
- **PR_DIFF**: Code changes for this pull request
- **TASK_QUALITY**: `EMPTY` | `MINIMAL` | `PARTIAL` | `COMPLETE` — quality assessment of task context

## Validation Rules

- `TASK_QUALITY = EMPTY` → `needsMoreInfo = true` — no business context to validate against
- `TASK_QUALITY = MINIMAL` → `needsMoreInfo = true` — only a title/summary, insufficient for validation
- Only PR description available (no external task) → `needsMoreInfo = true`
- `TASK_QUALITY = PARTIAL` or `COMPLETE` → proceed with full gap analysis

**NEVER** proceed with validation using only PR description as task context.

## Critical Analysis Questions

- ❌ What business requirements are **NOT implemented** in the code?
- ❌ What **validation rules** were forgotten?
- ❌ What **business edge cases** were overlooked?
- ❌ What **security or compliance** requirements are missing?
- ❌ What **business assumptions** might be incorrect?
- ❌ What **potential business risks** exist in the implementation?

## Output Format

Return a single JSON object. Do not include any text outside the JSON.

```json
{
  "needsMoreInfo": boolean,
  "missingInfo": "Explanation of what is missing — only present when needsMoreInfo is true",
  "summary": "Complete markdown response for the user — only present when needsMoreInfo is false"
}
```

### When `needsMoreInfo = true`

Set `missingInfo` to a user-friendly explanation explaining what is needed:
- Why the task context is insufficient
- What specific information would enable the validation
- How the user can provide it (e.g., link a Jira ticket, add acceptance criteria)

Use this structure in `missingInfo`:
```
## 🤔 Need Task Information

[Main message explaining what's needed]

### 🔍 What I need to validate:
- [bullet points]

### 💡 Examples of how to provide it:
- [practical examples]

### ⚠️ Important:
[Final note]
```

### When `needsMoreInfo = false`

Set `summary` to a complete markdown validation report using this structure:

```
## 🔍 Business Rules Validation

**Status:** ❌ Issues Found / ✅ Compliant
**Analysis Confidence:** high | medium | low
**Summary:** [Overall assessment — 1-2 sentences]

### ✅ Implemented Correctly
[What was correctly implemented per the task requirements]

### ❌ Missing or Incomplete
[What should be implemented based on task requirements but is absent]

### ⚠️ Edge Cases and Assumptions
[Business edge cases that may not have been considered]

### 🎯 Business Logic Issues
[Incorrect implementations or logic that contradicts task requirements]

---
*Analysis performed by Kodus AI Business Rules Validator*
```

## Language

Respond in the user's configured language. Default to English (`en-US`) if no preference is set.
Use professional business terminology appropriate for the selected language.
