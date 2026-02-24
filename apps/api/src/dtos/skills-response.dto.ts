import { ApiProperty } from '@nestjs/swagger';
import { ApiResponseBaseDto } from './api-response.dto';

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
