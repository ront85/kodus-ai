import z from 'zod';

export interface CrossFileContextPlannerPayload {
    diffSummary: string;
    changedFilenames: string[];
    language: string;
}

export const CrossFileContextPlannerSchema = z.object({
    queries: z
        .array(
            z.object({
                pattern: z.string().min(1),
                rationale: z.string().min(1),
                riskLevel: z.enum(['low', 'medium', 'high']),
                symbolName: z.string().optional(),
                fileGlob: z.string().optional(),
                sourceFile: z.string().min(1),
            }),
        )
        .max(8),
});

export type CrossFileContextPlannerSchemaType = z.infer<
    typeof CrossFileContextPlannerSchema
>;

export const prompt_cross_file_context_planner = (
    payload: CrossFileContextPlannerPayload,
) => {
    return `You are a code analysis planner. Your task is to analyze a PR diff and generate targeted ripgrep (rg) search patterns to find call-sites, consumers, and dependents in files OUTSIDE the PR.

## Goal
Given the diff summary and changed filenames below, produce up to 8 search queries that will help find code in the repository that may be affected by these changes. Focus on:
- Functions/methods/classes that were modified, renamed, or had their signatures changed
- Exported interfaces/types that changed shape
- Constants or config keys that were renamed or removed
- API endpoints or routes that were modified

## Input

### Changed Files
${JSON.stringify(payload.changedFilenames, null, 2)}

### Diff Summary
${payload.diffSummary}

## Instructions

1. Identify the most impactful symbols (functions, classes, types, constants) changed in the diff.
2. For each symbol, generate a regex pattern suitable for ripgrep that would find usages/call-sites of that symbol across the codebase.
3. Assign a riskLevel:
   - **high**: Signature changes, removed exports, renamed public APIs — callers will break
   - **medium**: Behavioral changes to widely-used functions, type narrowing
   - **low**: Internal refactors that might affect nearby consumers
4. Optionally provide a fileGlob to narrow the search (e.g., "*.ts" or "*.py").
5. Optionally provide the symbolName for the primary symbol being searched.

## Constraints
- Maximum 8 queries
- Patterns must be valid ripgrep regex
- Focus on finding CONSUMERS/CALLERS, not the definitions themselves
- Prefer precise patterns over broad ones to minimize noise
- Do NOT generate patterns that would only match inside the changed files themselves

## Output Format
Return a JSON object with a "queries" array. Each query has:
- pattern: ripgrep-compatible regex pattern
- rationale: why this search is important
- riskLevel: "low" | "medium" | "high"
- symbolName: (optional) the primary symbol name
- fileGlob: (optional) glob to filter files, e.g. "*.ts"
- sourceFile: the changed file where the symbol was modified (from the "Changed Files" list)

## Language
All rationale text must be in ${payload.language || 'en-US'}.
`;
};
