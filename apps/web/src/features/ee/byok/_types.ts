export type BYOKConfig = {
    model: string;
    apiKey?: string;
    credentialType?: 'api_key' | 'subscription_token';
    subscriptionToken?: string;
    provider: string;
    baseURL?: string;
    temperature?: number;
    maxInputTokens?: number;
    maxConcurrentRequests?: number;
    maxOutputTokens?: number;
};
