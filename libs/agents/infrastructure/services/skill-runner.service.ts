import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
    BlueprintContext,
    BlueprintResult,
    BlueprintStep,
} from '@libs/shared/blueprint/blueprint.types';
import { runBlueprint } from '@libs/shared/blueprint/blueprint.runner';
import { CircularSkillDependencyError } from '../../skills/skill.errors';
import { businessRulesBlueprint } from '../../skills/business-rules-validation/blueprint';

/** Registration record for a skill */
interface SkillRegistration {
    blueprint: BlueprintStep<any>[];
    /**
     * Called for each LLMStep — the registered skill must supply its own
     * runLLMStep implementation via this callback.
     */
    runLLMStep: (step: any, ctx: any) => Promise<any>;
}

export interface SkillExecutionError {
    skillName: string;
    error: Error;
    completedSteps: string[];
}

/**
 * SkillRunnerService — Thin execution orchestrator for registered skills.
 *
 * Responsibilities:
 * - Maintain a registry of skill blueprints and their LLM step delegates
 * - Run a single skill via runBlueprint()
 * - Run N skills concurrently with isolation (one failure doesn't block others)
 * - Detect circular skill dependencies at startup
 *
 * Injectable in any NestJS module that imports AgentsModule.
 */
@Injectable()
export class SkillRunnerService implements OnModuleInit {
    private readonly logger = new Logger(SkillRunnerService.name);
    private readonly registry = new Map<string, SkillRegistration>();

    onModuleInit(): void {
        // BusinessRulesValidation is registered at startup via the provider.
        // Additional skills are registered by calling registerSkill() during module init.
        this.detectCircularDependencies();
    }

    /**
     * Register a skill with its blueprint and LLM step handler.
     * Called by agent providers during NestJS initialization.
     */
    registerSkill(
        skillName: string,
        blueprint: BlueprintStep<any>[],
        runLLMStep: (step: any, ctx: any) => Promise<any>,
    ): void {
        this.registry.set(skillName, { blueprint, runLLMStep });
        this.logger.log(`[SkillRunner] registered skill: '${skillName}'`);
    }

    /**
     * Execute a single skill by name.
     */
    async run<T extends BlueprintContext>(
        skillName: string,
        context: T,
    ): Promise<BlueprintResult<T>> {
        const registration = this.registry.get(skillName);

        if (!registration) {
            throw new Error(
                `[SkillRunner] Skill '${skillName}' is not registered. ` +
                    `Call registerSkill() during module initialization.`,
            );
        }

        this.logger.log(
            `[SkillRunner] executing skill '${skillName}' for team ${(context as any)?.organizationAndTeamData?.teamId}`,
        );

        return runBlueprint<T>({
            steps: registration.blueprint as BlueprintStep<T>[],
            context,
            runLLMStep: registration.runLLMStep,
            logger: {
                log: (msg) => this.logger.log(msg),
                error: (msg, err) => this.logger.error(msg, err),
            },
        });
    }

    /**
     * Execute multiple skills concurrently.
     *
     * - All skills start at the same time (Promise.all semantics)
     * - A single skill failure does NOT block other skills
     * - Results are returned in the same order as skillNames
     */
    async runParallel<T extends BlueprintContext>(
        skillNames: string[],
        context: T,
        timeoutMs = 60_000,
    ): Promise<Array<BlueprintResult<T> | SkillExecutionError>> {
        this.logger.log(
            `[SkillRunner] running ${skillNames.length} skills in parallel: [${skillNames.join(', ')}]`,
        );

        const results = await Promise.all(
            skillNames.map((skillName) =>
                this.runWithTimeout<T>(skillName, { ...context }, timeoutMs),
            ),
        );

        return results;
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private async runWithTimeout<T extends BlueprintContext>(
        skillName: string,
        context: T,
        timeoutMs: number,
    ): Promise<BlueprintResult<T> | SkillExecutionError> {
        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(
                () =>
                    reject(
                        new Error(
                            `[SkillRunner] Skill '${skillName}' timed out after ${timeoutMs}ms`,
                        ),
                    ),
                timeoutMs,
            ),
        );

        try {
            return await Promise.race([
                this.run<T>(skillName, context),
                timeoutPromise,
            ]);
        } catch (error) {
            this.logger.error(
                `[SkillRunner] Skill '${skillName}' failed: ${error?.message}`,
                error,
            );
            return {
                skillName,
                error: error instanceof Error ? error : new Error(String(error)),
                completedSteps: [],
            };
        }
    }

    /**
     * DFS-based circular dependency detection across parallel steps.
     * Runs at startup — throws CircularSkillDependencyError if a cycle is found.
     */
    private detectCircularDependencies(): void {
        const visiting = new Set<string>();
        const visited = new Set<string>();

        const dfs = (skillName: string, path: string[]): void => {
            if (visited.has(skillName)) return;
            if (visiting.has(skillName)) {
                const cycleStart = path.indexOf(skillName);
                throw new CircularSkillDependencyError([
                    ...path.slice(cycleStart),
                    skillName,
                ]);
            }

            visiting.add(skillName);
            const registration = this.registry.get(skillName);

            if (registration) {
                for (const step of registration.blueprint) {
                    if (step.type === 'parallel') {
                        for (const subSkill of (step as any).skills) {
                            dfs(subSkill, [...path, skillName]);
                        }
                    }
                }
            }

            visiting.delete(skillName);
            visited.add(skillName);
        };

        for (const skillName of this.registry.keys()) {
            dfs(skillName, []);
        }

        this.logger.log(
            `[SkillRunner] dependency check passed — ${this.registry.size} skill(s) registered`,
        );
    }
}
