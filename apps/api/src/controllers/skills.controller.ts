import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Inject,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';

import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { SkillLoaderService } from '@libs/agents/skills/skill-loader.service';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';

import {
    SkillInstructionsResponseDto,
    SkillOverrideSavedResponseDto,
    SkillVersionsResponseDto,
} from '../dtos/skills-response.dto';

@ApiTags('Skills')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('skills')
export class SkillsController {
    constructor(
        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly skillLoaderService: SkillLoaderService,
    ) {}

    @Get(':skillName/instructions')
    @ApiParam({ name: 'skillName', example: 'business-rules-validation' })
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @ApiOperation({
        summary: 'Get skill instructions',
        description:
            'Return current instructions for a skill — DB override if one exists, filesystem SKILL.md otherwise.',
    })
    @ApiOkResponse({ type: SkillInstructionsResponseDto })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async getInstructions(
        @Param('skillName') skillName: string,
        @Query('teamId') teamId: string,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        // Check if a DB override exists to indicate the source
        const versions = await this.skillLoaderService.listVersions(skillName, {
            organizationId,
            teamId,
        });

        const instructions = await this.skillLoaderService.loadInstructions(
            skillName,
            { organizationId, teamId },
        );

        return {
            instructions,
            source: versions.length > 0 ? 'db' : 'filesystem',
        };
    }

    @Get(':skillName/versions')
    @ApiParam({ name: 'skillName', example: 'business-rules-validation' })
    @ApiQuery({ name: 'teamId', type: String, required: true })
    @ApiOperation({
        summary: 'List skill override versions',
        description:
            'Return all DB override versions saved for the skill+team, newest first.',
    })
    @ApiOkResponse({ type: SkillVersionsResponseDto })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async listVersions(
        @Param('skillName') skillName: string,
        @Query('teamId') teamId: string,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        return this.skillLoaderService.listVersions(skillName, {
            organizationId,
            teamId,
        });
    }

    @Post(':skillName/override')
    @ApiParam({ name: 'skillName', example: 'business-rules-validation' })
    @ApiOperation({
        summary: 'Save skill override',
        description:
            'Save a new version of the SKILL.md instructions for a team. The new version immediately becomes active.',
    })
    @ApiCreatedResponse({ type: SkillOverrideSavedResponseDto })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async saveOverride(
        @Param('skillName') skillName: string,
        @Body() body: { teamId: string; content: string },
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        const version = await this.skillLoaderService.saveOverride(
            skillName,
            body.content,
            { organizationId, teamId: body.teamId },
        );

        return { version };
    }

    @Post(':skillName/restore')
    @HttpCode(HttpStatus.OK)
    @ApiParam({ name: 'skillName', example: 'business-rules-validation' })
    @ApiOperation({
        summary: 'Restore skill version',
        description:
            'Restore a previous override version by creating a new record with that version\'s content.',
    })
    @ApiOkResponse({ description: 'Version restored successfully.' })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async restoreVersion(
        @Param('skillName') skillName: string,
        @Body() body: { teamId: string; version: number },
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        await this.skillLoaderService.restoreVersion(
            skillName,
            body.version,
            { organizationId, teamId: body.teamId },
        );
    }
}
