import { ChatAnthropic } from '@langchain/anthropic';
import { resolveModelOptions } from './resolver';
import { AdapterBuildParams, ProviderAdapter } from './types';

const OAUTH_BETAS = [
    'claude-code-20250219',
    'oauth-2025-04-20',
    'fine-grained-tool-streaming-2025-05-14',
    'interleaved-thinking-2025-05-14',
];

export class AnthropicAdapter implements ProviderAdapter {
    build(params: AdapterBuildParams): ChatAnthropic {
        const { model, apiKey, subscriptionToken, options } = params;
        const resolved = resolveModelOptions(model, {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
        });

        const maxTokens = resolved.resolvedMaxTokens ?? 4096;

        const reasoningBudget =
            resolved.supportsReasoning && resolved.reasoningType === 'budget'
                ? resolved.resolvedReasoningTokens
                : undefined;

        const payload: ConstructorParameters<typeof ChatAnthropic>[0] = {
            model,
            apiKey: subscriptionToken ? 'subscription-token' : apiKey,
            ...(subscriptionToken
                ? {
                      clientOptions: {
                          defaultHeaders: {
                              Authorization: `Bearer ${subscriptionToken}`,
                              'anthropic-beta': OAUTH_BETAS.join(','),
                          },
                      },
                  }
                : {}),
            ...(resolved.temperature !== undefined &&
            typeof reasoningBudget !== 'number'
                ? { temperature: resolved.temperature }
                : {}),
            maxTokens,
            ...(typeof reasoningBudget === 'number'
                ? {
                      thinking: {
                          type: 'enabled',
                          budget_tokens: reasoningBudget,
                      },
                  }
                : {}),
            callbacks: options?.callbacks,
        };

        return new ChatAnthropic(payload);
    }
}
