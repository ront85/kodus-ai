import * as fs from 'fs';
import * as path from 'path';

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { SkillOverrideModel } from '@libs/agents/infrastructure/adapters/repositories/schemas/skill-override.model';

import { SkillNotFoundError, SkillOverrideNotFoundError } from './skill.errors';
import {
    SkillEditableContent,
    SkillInstructionsBundle,
    SKILL_EDITABLE_SCHEMA_VERSION,
} from './skill-override.types';

const SKILL_DEFAULT_EDITABLE_TEMPLATE: Record<string, SkillEditableContent> = {
    'business-rules-validation': {
        schemaVersion: SKILL_EDITABLE_SCHEMA_VERSION,
        editable: {
            businessContext: '',
            orgRules: [],
            qualityThresholds: {
                empty: '',
                minimal: '',
                partial: '',
                complete: '',
            },
            reportStyle: {
                tone: 'professional',
                language: 'en-US',
            },
            examples: [],
        },
    },
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
    version?: string;
    /** MCP tool names the skill's fetcher agent is allowed to use. */
    allowedTools?: string[];
    /** External MCP plugin categories required for this skill to work. */
    requiredMcps?: SkillRequiredMcp[];
}

@Injectable()
export class SkillLoaderService {
    private readonly logger = new Logger(SkillLoaderService.name);

    constructor(
        @InjectRepository(SkillOverrideModel)
        private readonly skillOverrideRepository: Repository<SkillOverrideModel>,
    ) {}

    /**
     * Runtime instructions for the analyzer.
     *
     * Resolution order:
     * 1. Structured DB override (`skill_overrides`) + immutable filesystem base
     * 2. Filesystem skill only
     */
    async loadInstructions(
        skillName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        const baseInstructions = this.loadFromFilesystem(skillName);

        try {
            const latestStructured = await this.findLatestStructuredOverride(
                skillName,
                organizationAndTeamData.teamId,
            );

            if (latestStructured?.content) {
                const editable = this.normalizeEditableContent(
                    skillName,
                    latestStructured.content,
                );

                this.logger.log(
                    `[SkillLoader] loaded structured DB override v${latestStructured.overrideVersion} for skill '${skillName}' ` +
                        `(team: ${organizationAndTeamData?.teamId})`,
                );

                return this.composeInstructions(baseInstructions, editable);
            }
        } catch (err) {
            this.logger.warn(
                `[SkillLoader] structured DB lookup failed for skill '${skillName}', falling back: ${err?.message}`,
            );
        }

        return baseInstructions;
    }

    /**
     * Returns current display bundle for Settings UI:
     * - compiled runtime instructions (immutable + editable)
     * - editable JSON template
     * - source markers
     */
    async getInstructionsBundle(
        skillName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<SkillInstructionsBundle> {
        const baseInstructions = this.loadFromFilesystem(skillName);
        const defaultEditable = this.getDefaultEditableContent(skillName);

        const latestStructured = await this.findLatestStructuredOverride(
            skillName,
            organizationAndTeamData.teamId,
        );

        if (latestStructured?.content) {
            const editable = this.normalizeEditableContent(
                skillName,
                latestStructured.content,
            );
            return {
                instructions: this.composeInstructions(
                    baseInstructions,
                    editable,
                ),
                source: 'db',
                editable,
                defaultEditable,
                editableSource: 'db',
            };
        }

        return {
            instructions: baseInstructions,
            source: 'filesystem',
            editable: defaultEditable,
            defaultEditable,
            editableSource: 'default',
        };
    }

    /**
     * Read platform metadata (allowed-tools, name, description, version) from
     * filesystem SKILL.md frontmatter.
     */
    loadSkillMetaFromFilesystem(skillName: string): SkillMeta {
        const skillPath = path.join(__dirname, skillName, 'SKILL.md');
        if (!fs.existsSync(skillPath)) return {};
        const raw = fs.readFileSync(skillPath, 'utf-8');
        return this.parseFrontmatter(raw).meta;
    }

    /**
     * Saves a new structured editable override for this team+skill.
     */
    async saveOverride(
        skillName: string,
        editable: SkillEditableContent,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<number> {
        const normalized = this.normalizeEditableContent(skillName, editable);

        const maxVersion = await this.getMaxStructuredVersion(
            skillName,
            organizationAndTeamData.teamId,
        );
        const nextVersion = maxVersion + 1;

        const baseSkillVersion =
            this.loadSkillMetaFromFilesystem(skillName).version ?? '1.0.0';

        await this.skillOverrideRepository.save(
            this.skillOverrideRepository.create({
                team: { uuid: organizationAndTeamData.teamId } as any,
                key: skillName,
                baseSkillVersion,
                overrideVersion: nextVersion,
                content: normalized as Record<string, unknown>,
                active: true,
            }),
        );

        this.logger.log(
            `[SkillLoader] saved structured override v${nextVersion} for skill '${skillName}' ` +
                `(team: ${organizationAndTeamData?.teamId})`,
        );

        return nextVersion;
    }

    /**
     * Restores an old structured version by cloning its content into a new head version.
     */
    async restoreVersion(
        skillName: string,
        version: number,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        const target = await this.skillOverrideRepository
            .createQueryBuilder('skill_override')
            .where('skill_override.key = :skillName', { skillName })
            .andWhere('skill_override.team_id = :teamId', {
                teamId: organizationAndTeamData.teamId,
            })
            .andWhere('skill_override.overrideVersion = :version', { version })
            .andWhere('skill_override.active = true')
            .getOne();

        if (!target) {
            throw new SkillOverrideNotFoundError(skillName, version);
        }

        const maxVersion = await this.getMaxStructuredVersion(
            skillName,
            organizationAndTeamData.teamId,
        );

        await this.skillOverrideRepository.save(
            this.skillOverrideRepository.create({
                team: { uuid: organizationAndTeamData.teamId } as any,
                key: skillName,
                baseSkillVersion: target.baseSkillVersion,
                overrideVersion: maxVersion + 1,
                content: target.content,
                active: true,
            }),
        );

        this.logger.log(
            `[SkillLoader] restored v${version} as v${maxVersion + 1} for skill '${skillName}' ` +
                `(team: ${organizationAndTeamData?.teamId})`,
        );
    }

    /**
     * List structured DB override versions saved for a skill+team, newest first.
     */
    async listVersions(
        skillName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<Array<{ version: number; createdAt?: Date; updatedAt?: Date }>> {
        const rows = await this.skillOverrideRepository
            .createQueryBuilder('skill_override')
            .where('skill_override.key = :skillName', { skillName })
            .andWhere('skill_override.team_id = :teamId', {
                teamId: organizationAndTeamData.teamId,
            })
            .andWhere('skill_override.active = true')
            .orderBy('skill_override.overrideVersion', 'DESC')
            .getMany();

        return rows.map((r) => ({
            version: r.overrideVersion,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
        }));
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private async findLatestStructuredOverride(
        skillName: string,
        teamId: string,
    ): Promise<SkillOverrideModel | null> {
        return this.skillOverrideRepository
            .createQueryBuilder('skill_override')
            .where('skill_override.key = :skillName', { skillName })
            .andWhere('skill_override.team_id = :teamId', { teamId })
            .andWhere('skill_override.active = true')
            .orderBy('skill_override.overrideVersion', 'DESC')
            .getOne();
    }

    private async getMaxStructuredVersion(
        skillName: string,
        teamId: string,
    ): Promise<number> {
        const raw = await this.skillOverrideRepository
            .createQueryBuilder('skill_override')
            .select('MAX(skill_override.overrideVersion)', 'max')
            .where('skill_override.key = :skillName', { skillName })
            .andWhere('skill_override.team_id = :teamId', { teamId })
            .andWhere('skill_override.active = true')
            .getRawOne<{ max: string | null }>();

        return Number(raw?.max ?? 0);
    }

    private getDefaultEditableContent(skillName: string): SkillEditableContent {
        const template = SKILL_DEFAULT_EDITABLE_TEMPLATE[skillName];
        if (!template) {
            throw new Error(
                `[SkillLoader] No editable template mapped for skill '${skillName}'.`,
            );
        }

        return JSON.parse(JSON.stringify(template)) as SkillEditableContent;
    }

    private normalizeEditableContent(
        skillName: string,
        value: unknown,
    ): SkillEditableContent {
        const fallback = this.getDefaultEditableContent(skillName);

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Invalid editable payload: expected an object.');
        }

        const raw = value as Record<string, any>;
        if (Number(raw.schemaVersion) !== SKILL_EDITABLE_SCHEMA_VERSION) {
            throw new Error(
                `Invalid schemaVersion. Expected ${SKILL_EDITABLE_SCHEMA_VERSION}.`,
            );
        }

        const editable = raw.editable as Record<string, any>;
        if (
            !editable ||
            typeof editable !== 'object' ||
            Array.isArray(editable)
        ) {
            throw new Error(
                'Invalid editable payload: missing editable object.',
            );
        }

        const asString = (v: unknown, defaultValue = '') =>
            typeof v === 'string' ? v.trim() : defaultValue;
        const asStringArray = (v: unknown): string[] =>
            Array.isArray(v)
                ? v
                      .map((item) =>
                          typeof item === 'string' ? item.trim() : '',
                      )
                      .filter(Boolean)
                : [];

        const quality = editable.qualityThresholds as Record<string, any>;
        const reportStyle = editable.reportStyle as Record<string, any>;

        return {
            schemaVersion: SKILL_EDITABLE_SCHEMA_VERSION,
            editable: {
                businessContext: asString(
                    editable.businessContext,
                    fallback.editable.businessContext,
                ),
                orgRules: asStringArray(editable.orgRules),
                qualityThresholds: {
                    empty: asString(
                        quality?.empty,
                        fallback.editable.qualityThresholds.empty,
                    ),
                    minimal: asString(
                        quality?.minimal,
                        fallback.editable.qualityThresholds.minimal,
                    ),
                    partial: asString(
                        quality?.partial,
                        fallback.editable.qualityThresholds.partial,
                    ),
                    complete: asString(
                        quality?.complete,
                        fallback.editable.qualityThresholds.complete,
                    ),
                },
                reportStyle: {
                    tone: asString(
                        reportStyle?.tone,
                        fallback.editable.reportStyle.tone,
                    ),
                    language: asString(
                        reportStyle?.language,
                        fallback.editable.reportStyle.language,
                    ),
                },
                examples: asStringArray(editable.examples),
            },
        };
    }

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

    private composeInstructions(
        immutableBaseInstructions: string,
        editable: SkillEditableContent,
    ): string {
        const customBlock = this.renderEditableBlock(editable);
        if (!customBlock) return immutableBaseInstructions;
        return `${immutableBaseInstructions}\n\n---\n\n${customBlock}`;
    }

    private renderEditableBlock(editable: SkillEditableContent): string {
        const lines: string[] = [];
        const data = editable.editable;

        if (data.businessContext) {
            lines.push('### Organization Business Context');
            lines.push(data.businessContext);
            lines.push('');
        }

        if (data.orgRules.length > 0) {
            lines.push('### Organization Rules');
            for (const rule of data.orgRules) lines.push(`- ${rule}`);
            lines.push('');
        }

        const thresholds = data.qualityThresholds;
        if (
            thresholds.empty ||
            thresholds.minimal ||
            thresholds.partial ||
            thresholds.complete
        ) {
            lines.push('### Organization Quality Guidance');
            if (thresholds.empty) lines.push(`- EMPTY: ${thresholds.empty}`);
            if (thresholds.minimal)
                lines.push(`- MINIMAL: ${thresholds.minimal}`);
            if (thresholds.partial)
                lines.push(`- PARTIAL: ${thresholds.partial}`);
            if (thresholds.complete)
                lines.push(`- COMPLETE: ${thresholds.complete}`);
            lines.push('');
        }

        if (data.examples.length > 0) {
            lines.push('### Organization Examples');
            for (const example of data.examples) lines.push(`- ${example}`);
            lines.push('');
        }

        if (lines.length === 0) return '';

        return [
            '## Organization Customization (User Editable)',
            '',
            ...lines,
            `### Report Preferences`,
            `- Tone: ${data.reportStyle.tone || 'professional'}`,
            `- Language: ${data.reportStyle.language || 'en-US'}`,
        ].join('\n');
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
            .map((f) => fs.readFileSync(path.join(refsDir, f), 'utf-8').trim())
            .join('\n\n---\n\n');
    }

    /**
     * Parse YAML frontmatter from a SKILL.md string.
     *
     * Supports:
     * - name / description
     * - metadata.version
     * - allowed-tools list
     * - required-mcps list
     */
    private parseFrontmatter(raw: string): { body: string; meta: SkillMeta } {
        const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        if (!match) return { body: raw, meta: {} };

        const yamlStr = match[1];
        const body = match[2].trimStart();

        const name = yamlStr.match(/^name:\s*(.+)$/m)?.[1]?.trim();
        const description = yamlStr
            .match(/^description:\s*(.+)$/m)?.[1]
            ?.trim();

        const metadataVersion = yamlStr
            .match(
                /metadata:\s*\n(?:[ \t]+.+\n)*?[ \t]+version:\s*["']?([^"'\n]+)["']?/m,
            )?.[1]
            ?.trim();

        // Parse allowed-tools as a flat YAML list
        const toolsMatch = yamlStr.match(
            /^allowed-tools:\s*\n((?:[ \t]+-[ \t]+\S+[ \t]*\n?)+)/m,
        );
        const allowedTools = toolsMatch
            ? (toolsMatch[1].match(/\S+(?=\s*$)/gm) ?? [])
            : undefined;

        // Parse required-mcps as a list of objects with category/label/examples
        const requiredMcps = this.parseRequiredMcps(yamlStr);

        return {
            body,
            meta: {
                name,
                description,
                version: metadataVersion,
                allowedTools,
                requiredMcps,
            },
        };
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
}
