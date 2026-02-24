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
    @ApiProperty({ required: false, example: 'business-rules-validation' })
    name?: string;

    @ApiProperty({ required: false })
    description?: string;

    @ApiProperty({ required: false, example: '1.0.0' })
    version?: string;

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
    @ApiProperty({
        description:
            'Compiled instructions (immutable platform blocks + editable team blocks).',
    })
    instructions: string;

    @ApiProperty({
        enum: ['db', 'filesystem'],
        description: 'Source of the instructions',
    })
    source: 'db' | 'filesystem';

    @ApiProperty({
        type: Object,
        description:
            'Structured editable JSON payload. Only this section can be changed by users.',
    })
    editable: Record<string, unknown>;

    @ApiProperty({
        type: Object,
        description: 'Default editable JSON payload for reset action.',
    })
    defaultEditable: Record<string, unknown>;

    @ApiProperty({
        enum: ['db', 'default'],
        description: 'Source of the editable payload.',
    })
    editableSource: 'db' | 'default';
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
