import { Injectable } from '@nestjs/common';
import { BYOKProvider } from '@kodus/kodus-common/llm';

export interface ProviderInfo {
    id: string;
    name: string;
    description?: string;
    supported: boolean;
    requiresApiKey: boolean;
    requiresBaseUrl: boolean;
    supportsSubscriptionToken: boolean;
    subscriptionTokenSetupUrl?: string;
    subscriptionTokenInstructions?: string;
}

@Injectable()
export class ProviderService {
    private readonly providers: Record<string, ProviderInfo> = {
        [BYOKProvider.OPENAI]: {
            id: BYOKProvider.OPENAI,
            name: 'OpenAI',
            description: 'GPT models from OpenAI',
            supported: true,
            requiresApiKey: true,
            requiresBaseUrl: false,
            supportsSubscriptionToken: true,
            subscriptionTokenSetupUrl: 'https://github.com/openai/codex',
            subscriptionTokenInstructions: '1. Install Codex CLI: npm install -g @openai/codex\n2. Run: codex login\n3. Open: ~/.codex/auth.json\n4. Paste the entire file contents into the field below — Kodus will extract the token automatically.\n\nRequires ChatGPT Plus or Pro subscription.',
        },
        [BYOKProvider.ANTHROPIC]: {
            id: BYOKProvider.ANTHROPIC,
            name: 'Anthropic',
            description: 'Claude models from Anthropic',
            supported: true,
            requiresApiKey: true,
            requiresBaseUrl: false,
            supportsSubscriptionToken: true,
            subscriptionTokenSetupUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup-token',
            subscriptionTokenInstructions: '1. Open your terminal\n2. Run: claude setup-token\n3. Copy the token that starts with sk-ant-oat01-\n4. Paste it in the field above\n\nRequires Claude Code CLI with a Pro, Max, or Team subscription.',
        },
        [BYOKProvider.GOOGLE_GEMINI]: {
            id: BYOKProvider.GOOGLE_GEMINI,
            name: 'Google Gemini',
            description: 'Gemini models from Google AI',
            supported: true,
            requiresApiKey: true,
            requiresBaseUrl: false,
            supportsSubscriptionToken: false,
        },
        // [BYOKProvider.GOOGLE_VERTEX]: {
        //     id: BYOKProvider.GOOGLE_VERTEX,
        //     name: 'Google Vertex',
        //     description: 'Vertex AI models from Google Cloud',
        //     supported: true,
        //     requiresApiKey: true,
        //     requiresBaseUrl: false,
        //     supportsSubscriptionToken: false,
        // },
        [BYOKProvider.OPEN_ROUTER]: {
            id: BYOKProvider.OPEN_ROUTER,
            name: 'OpenRouter',
            description: 'Multiple models through OpenRouter',
            supported: true,
            requiresApiKey: true,
            requiresBaseUrl: false,
            supportsSubscriptionToken: false,
        },
        [BYOKProvider.NOVITA]: {
            id: BYOKProvider.NOVITA,
            name: 'Novita',
            description: 'Open source models from Novita',
            supported: true,
            requiresApiKey: true,
            requiresBaseUrl: false,
            supportsSubscriptionToken: false,
        },
        [BYOKProvider.OPENAI_COMPATIBLE]: {
            id: BYOKProvider.OPENAI_COMPATIBLE,
            name: 'OpenAI Compatible',
            description: 'Any OpenAI-compatible API endpoint',
            supported: true,
            requiresApiKey: true,
            requiresBaseUrl: true,
            supportsSubscriptionToken: false,
        },
    };

    /**
     * Get all available providers
     */
    getAllProviders(): ProviderInfo[] {
        return Object.values(this.providers).filter(
            (provider) => provider.supported,
        );
    }

    /**
     * Get provider by ID
     */
    getProvider(providerId: string): ProviderInfo | null {
        return this.providers[providerId] || null;
    }

    /**
     * Check if provider is supported
     */
    isProviderSupported(providerId: string): boolean {
        const provider = this.providers[providerId];
        return provider ? provider.supported : false;
    }

    /**
     * Get provider display name
     */
    getProviderDisplayName(providerId: string): string {
        const provider = this.providers[providerId];
        return provider ? provider.name : providerId;
    }

    /**
     * Validate provider configuration requirements
     */
    validateProviderConfig(
        providerId: string,
        config: { apiKey?: string; baseURL?: string },
    ): { isValid: boolean; errors: string[] } {
        const provider = this.providers[providerId];
        const errors: string[] = [];

        if (!provider) {
            errors.push(`Provider '${providerId}' is not supported`);
            return { isValid: false, errors };
        }

        if (provider.requiresApiKey && !config.apiKey) {
            errors.push(`API key is required for ${provider.name}`);
        }

        if (provider.requiresBaseUrl && !config.baseURL) {
            errors.push(`Base URL is required for ${provider.name}`);
        }

        return {
            isValid: errors.length === 0,
            errors,
        };
    }
}
