import * as fs from 'fs';
import * as path from 'path';

import { Injectable, Logger } from '@nestjs/common';

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
        if (!skillPath) return {};
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
        if (!refsDir) return '';

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
            /^required-mcps:\s*\n((?:[ \t]{2,}.*(?:\n|$))*)/m,
        );
        if (!blockMatch || !blockMatch[1].trim()) return undefined;

        const block = blockMatch[1].trimEnd();
        const items: SkillRequiredMcp[] = [];

        const itemBlocks = block.split(/\n(?=[ \t]*-[ \t]+)/);

        for (const itemBlock of itemBlocks) {
            const normalized = itemBlock.replace(/^[ \t]*-[ \t]*/, '');
            const category = normalized
                .match(/(?:^|\n)[ \t]*category:\s*(.+)/)?.[1]
                ?.trim();
            const label = normalized
                .match(/(?:^|\n)[ \t]*label:\s*(.+)/)?.[1]
                ?.trim();
            const examples = normalized
                .match(/(?:^|\n)[ \t]*examples:\s*(.+)/)?.[1]
                ?.trim();
            if (category && label) {
                items.push({ category, label, ...(examples && { examples }) });
            }
        }

        return items.length > 0 ? items : undefined;
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
