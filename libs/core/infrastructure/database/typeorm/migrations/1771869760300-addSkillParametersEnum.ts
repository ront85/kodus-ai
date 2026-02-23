import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'skill_business_rules_validation' to parameters_configkey_enum.
 * This enables per-team SKILL.md overrides to be stored in the existing parameters table.
 */
export class AddSkillParametersEnum1771869760300 implements MigrationInterface {
    name = 'AddSkillParametersEnum1771869760300';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."parameters_configkey_enum"
            RENAME TO "parameters_configkey_enum_old"
        `);
        await queryRunner.query(`
            CREATE TYPE "public"."parameters_configkey_enum" AS ENUM(
                'board_priority_type',
                'checkin_config',
                'code_review_config',
                'communication_style',
                'deployment_type',
                'organization_artifacts_config',
                'team_artifacts_config',
                'platform_configs',
                'language_config',
                'issue_creation_config',
                'skill_business_rules_validation'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "parameters"
            ALTER COLUMN "configKey" TYPE "public"."parameters_configkey_enum"
            USING "configKey"::"text"::"public"."parameters_configkey_enum"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."parameters_configkey_enum_old"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TYPE "public"."parameters_configkey_enum_old" AS ENUM(
                'board_priority_type',
                'checkin_config',
                'code_review_config',
                'communication_style',
                'deployment_type',
                'organization_artifacts_config',
                'team_artifacts_config',
                'platform_configs',
                'language_config',
                'issue_creation_config'
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "parameters"
            ALTER COLUMN "configKey" TYPE "public"."parameters_configkey_enum_old"
            USING "configKey"::"text"::"public"."parameters_configkey_enum_old"
        `);
        await queryRunner.query(`
            DROP TYPE "public"."parameters_configkey_enum"
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."parameters_configkey_enum_old"
            RENAME TO "parameters_configkey_enum"
        `);
    }
}
