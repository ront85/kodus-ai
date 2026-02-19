import { Inject } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IProfileService,
    PROFILE_SERVICE_TOKEN,
} from '@libs/identity/domain/profile/contracts/profile.service.contract';

export class SaveMarketingSurveyUseCase implements IUseCase {
    constructor(
        @Inject(PROFILE_SERVICE_TOKEN)
        private readonly profileService: IProfileService,
    ) {}

    public async execute(
        userId: string,
        data: { referralSource?: string; primaryGoal?: string },
    ): Promise<void> {
        await this.profileService.update(
            { user: { uuid: userId } },
            {
                referralSource: data.referralSource,
                primaryGoal: data.primaryGoal,
            },
        );
    }
}
