import * as fs from 'fs';
import * as path from 'path';

import { Injectable, Inject, Logger } from '@nestjs/common';

import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

import { SkillNotFoundError, SkillOverrideNotFoundError } from './skill.errors';

/** Maps skill name → ParametersKey for DB override lookup */
const SKILL_KEY_MAP: Record<string, ParametersKey> = {
    'business-rules-validation':
        ParametersKey.SKILL_BUSINESS_RULES_VALIDATION,
};

/** A required external MCP plugin category declared in SKILL.md frontmatter. */
export interface SkillRequiredMcp {
    /** Machine-readable category key, e.g. "task-management" */
    category: string;
    /** Human-readable label, e.g. "Task Management" */
    label: string;
    /** Comma-separated plugin examples shown to the user, e.g. "Jira, Linear, Notion" */
    examples?: string;
}

/** Platform-level metadata parsed from SKILL.md frontmatter. Not user-editable. */
export interface SkillMeta {
    name?: string;
    description?: string;
    /** MCP tool names the skill's fetcher agent is allowed to use. */
    allowedTools?: string[];
    /** External MCP plugin categories required for this skill to work. */
    requiredMcps?: SkillRequiredMcp[];
}

@Injectable()
export class SkillLoaderService {
    private readonly logger = new Logger(SkillLoaderService.name);

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
    ) {}

    /**
     * Load skill instructions for a given team.
     *
     * Resolution order:
     * 1. DB: all active records for configKey + team, highest version wins
     * 2. Filesystem: libs/agents/skills/{skillName}/SKILL.md
     * 3. Throws SkillNotFoundError if both unavailable
     *
     * Frontmatter is stripped before returning — the LLM receives only the
     * Markdown body. References (references/*.md) are appended when present.
     *
     * DB failure silently falls back to filesystem — reviews must never fail
     * due to a transient override fetch error.
     */
    async loadInstructions(
        skillName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        const configKey = SKILL_KEY_MAP[skillName];

        if (configKey) {
            try {
                const allVersions = await this.parametersService.find({
                    configKey,
                    team: { uuid: organizationAndTeamData.teamId } as any,
                });

                const latest = allVersions
                    ?.sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];

                if (latest?.configValue?.content) {
                    this.logger.log(
                        `[SkillLoader] loaded DB override v${latest.version} for skill '${skillName}' ` +
                            `(team: ${organizationAndTeamData?.teamId})`,
                    );
                    // Strip frontmatter — DB override may or may not include it
                    return this.parseFrontmatter(latest.configValue.content).body;
                }
            } catch (err) {
                this.logger.warn(
                    `[SkillLoader] DB lookup failed for skill '${skillName}', falling back to filesystem: ${err?.message}`,
                );
            }
        }

        return this.loadFromFilesystem(skillName);
    }

    /**
     * Read platform metadata (allowed-tools, name, description) from the
     * filesystem SKILL.md frontmatter.
     *
     * Always reads from the filesystem — this metadata is platform-owned and
     * is not overridable by teams via the DB override API.
     */
    loadSkillMetaFromFilesystem(skillName: string): SkillMeta {
        const skillPath = path.join(__dirname, skillName, 'SKILL.md');
        if (!fs.existsSync(skillPath)) return {};
        const raw = fs.readFileSync(skillPath, 'utf-8');
        return this.parseFrontmatter(raw).meta;
    }

    /**
     * Save a new version of a team's SKILL.md instruction override.
     *
     * All previous records remain active — the highest version number is always
     * the current one. This avoids the need to find inactive records when
     * restoring older versions.
     *
     * Returns the new version number.
     */
    async saveOverride(
        skillName: string,
        content: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<number> {
        const configKey = this.requireConfigKey(skillName);

        const existing = await this.parametersService.find({
            configKey,
            team: { uuid: organizationAndTeamData.teamId } as any,
        });

        const maxVersion =
            existing?.reduce((max, r) => Math.max(max, r.version ?? 0), 0) ??
            0;
        const nextVersion = maxVersion + 1;

        await this.parametersService.create({
            uuid: undefined as any,
            configKey,
            configValue: { content } as any,
            team: { uuid: organizationAndTeamData.teamId } as any,
            version: nextVersion,
            active: true,
        });

        this.logger.log(
            `[SkillLoader] saved override v${nextVersion} for skill '${skillName}' ` +
                `(team: ${organizationAndTeamData?.teamId})`,
        );

        return nextVersion;
    }

    /**
     * Restore a previous version by creating a new record with that version's
     * content, making it the new highest-version (current) entry.
     *
     * Works with the existing repository API — no need to query inactive records.
     */
    async restoreVersion(
        skillName: string,
        version: number,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        const configKey = this.requireConfigKey(skillName);

        const allVersions = await this.parametersService.find({
            configKey,
            team: { uuid: organizationAndTeamData.teamId } as any,
        });

        const target = allVersions?.find((r) => r.version === version);

        if (!target) {
            throw new SkillOverrideNotFoundError(skillName, version);
        }

        const maxVersion =
            allVersions.reduce((max, r) => Math.max(max, r.version ?? 0), 0);

        await this.parametersService.create({
            uuid: undefined as any,
            configKey,
            configValue: target.configValue,
            team: { uuid: organizationAndTeamData.teamId } as any,
            version: maxVersion + 1,
            active: true,
        });

        this.logger.log(
            `[SkillLoader] restored v${version} as v${maxVersion + 1} for skill '${skillName}' ` +
                `(team: ${organizationAndTeamData?.teamId})`,
        );
    }

    /**
     * List all DB override versions saved for a skill+team, newest first.
     * Returns an empty array when no overrides have been saved yet.
     */
    async listVersions(
        skillName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<Array<{ version: number; createdAt?: Date; updatedAt?: Date }>> {
        const configKey = this.requireConfigKey(skillName);

        const all = await this.parametersService.find({
            configKey,
            team: { uuid: organizationAndTeamData.teamId } as any,
        });

        return (all ?? [])
            .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
            .map((r) => ({
                version: r.version ?? 0,
                createdAt: r.createdAt,
                updatedAt: r.updatedAt,
            }));
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    /**
     * Load SKILL.md from filesystem, strip frontmatter, and append any
     * reference files found in references/*.md.
     */
    private loadFromFilesystem(skillName: string): string {
        const skillPath = path.join(__dirname, skillName, 'SKILL.md');

        if (!fs.existsSync(skillPath)) {
            throw new SkillNotFoundError(skillName);
        }

        this.logger.log(
            `[SkillLoader] loaded filesystem SKILL.md for skill '${skillName}'`,
        );

        const raw = fs.readFileSync(skillPath, 'utf-8');
        const { body } = this.parseFrontmatter(raw);

        const refs = this.loadReferences(skillName);
        return refs
            ? `${body}\n\n---\n\n## Reference Material\n\n${refs}`
            : body;
    }

    /**
     * Concatenate all .md files in references/ sorted alphabetically.
     * Returns an empty string when the directory does not exist.
     */
    private loadReferences(skillName: string): string {
        const refsDir = path.join(__dirname, skillName, 'references');
        if (!fs.existsSync(refsDir)) return '';

        const files = fs
            .readdirSync(refsDir)
            .filter((f) => f.endsWith('.md'))
            .sort();

        if (files.length === 0) return '';

        this.logger.log(
            `[SkillLoader] loading ${files.length} reference file(s) for skill '${skillName}'`,
        );

        return files
            .map((f) =>
                fs.readFileSync(path.join(refsDir, f), 'utf-8').trim(),
            )
            .join('\n\n---\n\n');
    }

    /**
     * Parse YAML frontmatter from a SKILL.md string.
     *
     * Supports the `allowed-tools` field as a YAML list:
     *   allowed-tools:
     *     - TOOL_NAME
     *
     * Returns the Markdown body (without frontmatter) and the parsed metadata.
     * If no frontmatter is present, returns the raw content as the body.
     */
    private parseFrontmatter(raw: string): { body: string; meta: SkillMeta } {
        const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        if (!match) return { body: raw, meta: {} };

        const yamlStr = match[1];
        const body = match[2].trimStart();

        // Parse allowed-tools as a flat YAML list
        const toolsMatch = yamlStr.match(
            /^allowed-tools:\s*\n((?:[ \t]+-[ \t]+\S+[ \t]*\n?)+)/m,
        );
        const allowedTools = toolsMatch
            ? (toolsMatch[1].match(/\S+(?=\s*$)/gm) ?? [])
            : undefined;

        // Parse required-mcps as a list of objects with category/label/examples
        const requiredMcps = this.parseRequiredMcps(yamlStr);

        return { body, meta: { allowedTools, requiredMcps } };
    }

    /**
     * Parse the required-mcps YAML block:
     *
     *   required-mcps:
     *     - category: task-management
     *       label: Task Management
     *       examples: Jira, Linear, Notion
     */
    private parseRequiredMcps(yamlStr: string): SkillRequiredMcp[] | undefined {
        const blockMatch = yamlStr.match(
            /^required-mcps:\s*\n((?:[ \t]+[\s\S]*?)(?=\n\S|\n*$))/m,
        );
        if (!blockMatch) return undefined;

        const block = blockMatch[1];
        const items: SkillRequiredMcp[] = [];

        // Split on list item starters (lines beginning with "  -")
        const itemBlocks = block.split(/\n(?=[ \t]+-[ \t])/);

        for (const itemBlock of itemBlocks) {
            const category = itemBlock.match(/category:\s*(.+)/)?.[1]?.trim();
            const label = itemBlock.match(/label:\s*(.+)/)?.[1]?.trim();
            const examples = itemBlock.match(/examples:\s*(.+)/)?.[1]?.trim();
            if (category && label) {
                items.push({ category, label, ...(examples && { examples }) });
            }
        }

        return items.length > 0 ? items : undefined;
    }

    private requireConfigKey(skillName: string): ParametersKey {
        const configKey = SKILL_KEY_MAP[skillName];
        if (!configKey) {
            throw new Error(
                `[SkillLoader] No ParametersKey mapping for skill '${skillName}'. ` +
                    `Add it to SKILL_KEY_MAP in skill-loader.service.ts`,
            );
        }
        return configKey;
    }
}
