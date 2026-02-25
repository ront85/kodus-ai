import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { SkillNotFoundError } from './skill.errors';

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

const SkillFrontmatterSchema = z
    .object({
        name: z.string().optional(),
        description: z.string().optional(),
        metadata: z
            .object({
                version: z.union([z.string(), z.number()]).optional(),
            })
            .optional(),
        'allowed-tools': z.array(z.string()).optional(),
        'required-mcps': z
            .array(
                z.object({
                    category: z.string(),
                    label: z.string(),
                    examples: z.string().optional(),
                }),
            )
            .optional(),
    })
    .passthrough();

@Injectable()
export class SkillLoaderService {
    private readonly logger = new Logger(SkillLoaderService.name);

    /**
     * Runtime instructions for the analyzer.
     * Loads SKILL.md body + appends any references/*.md files.
     */
    loadInstructions(skillName: string): string {
        return this.loadFromFilesystem(skillName);
    }

    /**
     * Read platform metadata (allowed-tools, name, description, version, required-mcps)
     * from filesystem SKILL.md frontmatter.
     */
    loadSkillMetaFromFilesystem(skillName: string): SkillMeta {
        const skillPath = this.resolveSkillFilePath(skillName, 'SKILL.md');
        if (!skillPath) {
            return {};
        }
        const raw = fs.readFileSync(skillPath, 'utf-8');
        return this.parseFrontmatter(raw).meta;
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    /**
     * Load SKILL.md from filesystem, strip frontmatter, and append any
     * reference files found in references/*.md.
     */
    private loadFromFilesystem(skillName: string): string {
        const skillPath = this.resolveSkillFilePath(skillName, 'SKILL.md');
        if (!skillPath) {
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
        const refsDir = this.resolveSkillDirectoryPath(skillName, 'references');
        if (!refsDir) {
            return '';
        }
        const files = fs
            .readdirSync(refsDir)
            .filter((f) => f.endsWith('.md'))
            .sort();

        if (files.length === 0) {
            return '';
        }

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
        if (!match) {
            return { body: raw, meta: {} };
        }

        const yamlStr = match[1];
        const body = match[2].trimStart();
        let frontmatter: unknown;
        try {
            frontmatter = yaml.load(yamlStr) ?? {};
        } catch {
            this.logger.warn(
                `[SkillLoader] invalid YAML frontmatter detected. Falling back to empty metadata.`,
            );
            return { body, meta: {} };
        }

        const parsed = SkillFrontmatterSchema.safeParse(frontmatter);
        if (!parsed.success) {
            this.logger.warn(
                `[SkillLoader] frontmatter schema validation failed. Falling back to empty metadata.`,
            );
            return { body, meta: {} };
        }

        return {
            body,
            meta: {
                name: parsed.data.name,
                description: parsed.data.description,
                version: parsed.data.metadata?.version?.toString(),
                allowedTools: parsed.data['allowed-tools'],
                requiredMcps: parsed.data['required-mcps'],
            },
        };
    }

    private resolveSkillFilePath(
        skillName: string,
        fileName: string,
    ): string | null {
        for (const baseDir of this.getSkillsBaseDirCandidates()) {
            const candidate = path.join(baseDir, skillName, fileName);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        this.logger.warn(
            `[SkillLoader] could not resolve file '${fileName}' for skill '${skillName}'.`,
        );

        return null;
    }

    private resolveSkillDirectoryPath(
        skillName: string,
        directoryName: string,
    ): string | null {
        for (const baseDir of this.getSkillsBaseDirCandidates()) {
            const candidate = path.join(baseDir, skillName, directoryName);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    private getSkillsBaseDirCandidates(): string[] {
        const candidates = [
            // Development runtime (docker volume mounted source)
            path.join(process.cwd(), 'libs', 'agents', 'skills'),
            // ts-node / direct source execution
            __dirname,
            // Built runtime fallback
            path.join(__dirname, '..', '..', 'skills'),
        ];

        return [...new Set(candidates)];
    }
}
