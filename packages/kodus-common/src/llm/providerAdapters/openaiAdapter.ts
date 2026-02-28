import { ChatOpenAI } from '@langchain/openai';
import { resolveModelOptions } from './resolver';
import { supportsJsonMode } from './capabilities';
import { AdapterBuildParams, ProviderAdapter } from './types';

export class OpenAIAdapter implements ProviderAdapter {
    build(params: AdapterBuildParams): ChatOpenAI {
        const { model, apiKey, subscriptionToken, chatgptAccountId, baseURL, options } = params;
        const resolved = resolveModelOptions(model, {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
            maxReasoningTokens: options?.maxReasoningTokens,
        });

        const reasoningEffort =
            resolved.supportsReasoning &&
            resolved.reasoningType === 'level' &&
            resolved.resolvedReasoningLevel
                ? resolved.resolvedReasoningLevel
                : undefined;

        // Check if reasoning should be explicitly disabled (e.g., for GLM models via OpenRouter)
        const disableReasoning = options?.disableReasoning === true;

        const isCodexSubscription = !!subscriptionToken;

        const payload: ConstructorParameters<typeof ChatOpenAI>[0] = {
            model,
            apiKey: isCodexSubscription ? 'chatgpt-oauth' : apiKey,
            // Codex API rejects max_output_tokens — omit for subscription tokens
            ...(!isCodexSubscription && resolved.resolvedMaxTokens
                ? { maxTokens: resolved.resolvedMaxTokens }
                : {}),
            ...(resolved.temperature !== undefined
                ? { temperature: resolved.temperature }
                : {}),
            ...(disableReasoning
                ? {
                      // Pass reasoning: { enabled: false } via modelKwargs for OpenRouter
                      modelKwargs: { reasoning: { enabled: false } },
                  }
                : reasoningEffort
                  ? {
                        reasoning: { effort: reasoningEffort },
                        reasoningEffort,
                    }
                  : {}),
            // Codex subscription always needs responses API; for regular keys only when model supports reasoning
            ...(isCodexSubscription || (resolved.supportsReasoning && resolved.reasoningType === 'level')
                ? { useResponsesApi: true }
                : {}),
            // Codex API requires store:false
            ...(isCodexSubscription ? { store: false } : {}),
            ...(options?.jsonMode && supportsJsonMode(model)
                ? {
                      response_format: { type: 'json_object' as const },
                  }
                : {}),
            callbacks: options?.callbacks,
            configuration: {
                ...(subscriptionToken
                    ? {
                          // LangChain ChatOpenAI appends /responses to baseURL when useResponsesApi=true
                          // Setting baseURL to .../codex routes calls to /codex/responses
                          baseURL: 'https://chatgpt.com/backend-api/codex',
                          defaultHeaders: {
                              Authorization: `Bearer ${subscriptionToken}`,
                              ...(chatgptAccountId ? { 'ChatGPT-Account-ID': chatgptAccountId } : {}),
                              'originator': 'codex_cli_rs',
                          },
                      }
                    : { ...(baseURL ? { baseURL } : {}) }),
            },
        };

        // Debug log to see what's being passed
        if (disableReasoning) {
            console.log('[OpenAIAdapter] Payload with disableReasoning:', JSON.stringify({
                model: payload.model,
                modelKwargs: payload.modelKwargs,
                baseURL: payload.configuration?.baseURL,
            }, null, 2));
        }

        return new ChatOpenAI(payload);
    }
}
