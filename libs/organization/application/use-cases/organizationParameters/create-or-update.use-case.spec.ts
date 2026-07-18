import { BYOKCredentialType, BYOKProvider } from '@kodus/kodus-common/llm';

import { CreateOrUpdateOrganizationParametersUseCase } from './create-or-update.use-case';

describe('CreateOrUpdateOrganizationParametersUseCase subscription credentials', () => {
    const useCase = Object.create(
        CreateOrUpdateOrganizationParametersUseCase.prototype,
    ) as CreateOrUpdateOrganizationParametersUseCase;

    it('keeps the saved OAuth credential when only the model changes', () => {
        const existing = {
            provider: BYOKProvider.OPENAI,
            model: 'gpt-5.5',
            credentialType: BYOKCredentialType.SUBSCRIPTION_TOKEN,
            subscriptionToken: 'encrypted-access-token',
            refreshToken: 'encrypted-refresh-token',
            tokenExpiresAt: 123456,
            chatgptAccountId: 'account-id',
        };

        const result = (useCase as any).encryptSlot(
            'main',
            {
                provider: BYOKProvider.OPENAI,
                model: 'gpt-5.6-sol',
                credentialType: BYOKCredentialType.SUBSCRIPTION_TOKEN,
            },
            existing,
        );

        expect(result).toEqual({
            provider: BYOKProvider.OPENAI,
            model: 'gpt-5.6-sol',
            credentialType: BYOKCredentialType.SUBSCRIPTION_TOKEN,
            subscriptionToken: 'encrypted-access-token',
            refreshToken: 'encrypted-refresh-token',
            tokenExpiresAt: 123456,
            chatgptAccountId: 'account-id',
        });
    });

    it('still requires a token for a new subscription configuration', () => {
        expect(() =>
            (useCase as any).encryptSlot('main', {
                provider: BYOKProvider.OPENAI,
                model: 'gpt-5.6-sol',
                credentialType: BYOKCredentialType.SUBSCRIPTION_TOKEN,
            }),
        ).toThrow(
            'subscriptionToken is required when using subscription token credential type',
        );
    });
});
