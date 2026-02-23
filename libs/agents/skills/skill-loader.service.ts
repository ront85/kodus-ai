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
     * 1. DB: parameters WHERE configKey = skill_key AND team = team AND active = true
     * 2. Filesystem: libs/agents/skills/{skillName}/SKILL.md
     * 3. Throws SkillNotFoundError if both unavailable
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
                const override = await this.parametersService.findByKey(
                    configKey,
                    organizationAndTeamData,
                );

                if (override?.configValue?.content) {
                    this.logger.log(
                        `[SkillLoader] loaded DB override for skill '${skillName}' ` +
                            `(team: ${organizationAndTeamData?.teamId})`,
                    );
                    return override.configValue.content;
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
     * Save or update a team's SKILL.md instruction override.
     *
     * Deactivates the current active record and creates a new one with
     * version = previous_max + 1. Returns the new version number.
     */
    async saveOverride(
        skillName: string,
        content: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<number> {
        const configKey = this.requireConfigKey(skillName);

        const existing = await this.parametersService.findByKey(
            configKey,
            organizationAndTeamData,
        );

        let nextVersion = 1;

        if (existing) {
            nextVersion = (existing.version ?? 1) + 1;
            await this.parametersService.update(
                { uuid: existing.uuid },
                { active: false },
            );
        }

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
     * Restore a previous version of a team's skill override.
     *
     * Deactivates the current active record and activates the requested version.
     */
    async restoreVersion(
        skillName: string,
        version: number,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        const configKey = this.requireConfigKey(skillName);

        const current = await this.parametersService.findByKey(
            configKey,
            organizationAndTeamData,
        );

        if (current) {
            await this.parametersService.update(
                { uuid: current.uuid },
                { active: false },
            );
        }

        const allVersions = await this.parametersService.find({
            configKey,
            team: { uuid: organizationAndTeamData.teamId } as any,
            version,
        });

        const target = allVersions?.[0];

        if (!target) {
            throw new SkillOverrideNotFoundError(skillName, version);
        }

        await this.parametersService.update(
            { uuid: target.uuid },
            { active: true },
        );

        this.logger.log(
            `[SkillLoader] restored v${version} for skill '${skillName}' ` +
                `(team: ${organizationAndTeamData?.teamId})`,
        );
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private loadFromFilesystem(skillName: string): string {
        const skillPath = path.join(__dirname, skillName, 'SKILL.md');

        if (!fs.existsSync(skillPath)) {
            throw new SkillNotFoundError(skillName);
        }

        this.logger.log(
            `[SkillLoader] loaded filesystem SKILL.md for skill '${skillName}'`,
        );

        return fs.readFileSync(skillPath, 'utf-8');
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
