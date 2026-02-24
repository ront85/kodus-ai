import { ApiProperty } from '@nestjs/swagger';
import { ApiResponseBaseDto } from './api-response.dto';

export class SkillRequiredMcpDto {
    @ApiProperty({ example: 'task-management' })
    category: string;

    @ApiProperty({ example: 'Task Management' })
    label: string;

    @ApiProperty({ example: 'Jira, Linear, Notion', required: false })
    examples?: string;
}

export class SkillMetaDto {
    @ApiProperty({ type: [String], required: false })
    allowedTools?: string[];

    @ApiProperty({ type: [SkillRequiredMcpDto], required: false })
    requiredMcps?: SkillRequiredMcpDto[];
}

export class SkillMetaResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: SkillMetaDto })
    data: SkillMetaDto;
}

export class SkillInstructionsDto {
    @ApiProperty({ description: 'Raw SKILL.md content (DB override or filesystem default)' })
    instructions: string;

    @ApiProperty({ enum: ['db', 'filesystem'], description: 'Source of the instructions' })
    source: 'db' | 'filesystem';
}

export class SkillVersionDto {
    @ApiProperty() version: number;
    @ApiProperty({ nullable: true }) createdAt?: string;
    @ApiProperty({ nullable: true }) updatedAt?: string;
}

export class SkillInstructionsResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: SkillInstructionsDto })
    data: SkillInstructionsDto;
}

export class SkillVersionsResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: [SkillVersionDto] })
    data: SkillVersionDto[];
}

export class SkillOverrideSavedResponseDto extends ApiResponseBaseDto {
    @ApiProperty({ type: Object, example: { version: 2 } })
    data: { version: number };
}
