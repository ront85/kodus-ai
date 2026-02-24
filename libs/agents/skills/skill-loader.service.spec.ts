import { SkillLoaderService } from './skill-loader.service';

describe('SkillLoaderService', () => {
    it('should keep filesystem bundle when there is no structured override', async () => {
        const queryBuilder = {
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue(null),
        };

        const skillOverrideRepository = {
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        };

        const parametersService = {
            find: jest.fn().mockResolvedValue([
                {
                    version: 1,
                    configValue: {
                        content:
                            '---\nname: Business Rules Validation\n---\nlegacy override',
                    },
                },
            ]),
        };

        const LoaderCtor = SkillLoaderService as any;
        const service: SkillLoaderService =
            LoaderCtor.length >= 2
                ? new LoaderCtor(
                      parametersService as any,
                      skillOverrideRepository as any,
                  )
                : new LoaderCtor(skillOverrideRepository as any);

        const bundle = await service.getInstructionsBundle(
            'business-rules-validation',
            {
                teamId: 'team-1',
            } as any,
        );

        expect(bundle.source).toBe('filesystem');
        expect(bundle.editableSource).toBe('default');
        expect(parametersService.find).not.toHaveBeenCalled();
    });
});
