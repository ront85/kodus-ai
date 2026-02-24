import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { TeamModel } from '@libs/organization/infrastructure/adapters/repositories/schemas/team.model';
import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';

@Entity('skill_overrides')
@Index('IDX_skill_overrides_team_skill_active', ['team', 'key', 'active'], {
    concurrent: true,
})
@Index(
    'IDX_skill_overrides_team_skill_version_unique',
    ['team', 'key', 'overrideVersion'],
    {
        unique: true,
        concurrent: true,
    },
)
export class SkillOverrideModel extends CoreModel {
    @ManyToOne(() => TeamModel, { nullable: false })
    @JoinColumn({ name: 'team_id', referencedColumnName: 'uuid' })
    team: TeamModel;

    @Column({ type: 'varchar' })
    key: string;

    @Column({ type: 'varchar' })
    baseSkillVersion: string;

    @Column({ type: 'integer' })
    overrideVersion: number;

    @Column({ type: 'jsonb' })
    content: Record<string, unknown>;

    @Column({ type: 'boolean', default: true })
    active: boolean;
}
