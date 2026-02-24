import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSkillOverrides1771963882383 implements MigrationInterface {
    name = 'CreateSkillOverrides1771963882383'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "skill_overrides" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "key" character varying NOT NULL,
                "baseSkillVersion" character varying NOT NULL,
                "overrideVersion" integer NOT NULL,
                "content" jsonb NOT NULL,
                "active" boolean NOT NULL DEFAULT true,
                "team_id" uuid NOT NULL,
                CONSTRAINT "PK_530ca35d9927bd164d709f2f6fe" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX CONCURRENTLY "IDX_skill_overrides_team_skill_version_unique" ON "skill_overrides" ("team_id", "key", "overrideVersion")
        `);
        await queryRunner.query(`
            CREATE INDEX CONCURRENTLY "IDX_skill_overrides_team_skill_active" ON "skill_overrides" ("team_id", "key", "active")
        `);
        await queryRunner.query(`
            ALTER TABLE "skill_overrides"
            ADD CONSTRAINT "FK_814efdf3956ffb5ca3398a8d7f4" FOREIGN KEY ("team_id") REFERENCES "teams"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "skill_overrides" DROP CONSTRAINT "FK_814efdf3956ffb5ca3398a8d7f4"
        `);
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY "public"."IDX_skill_overrides_team_skill_active"
        `);
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY "public"."IDX_skill_overrides_team_skill_version_unique"
        `);
        await queryRunner.query(`
            DROP TABLE "skill_overrides"
        `);
    }

}
