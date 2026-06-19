import { z } from "zod";

const baseFields = {
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    // Credential strategy. "api_key" (default) uses a provider API key;
    // "subscription_token" uses a Claude OAuth / Codex auth.json token.
    credentialType: z
        .enum(["api_key", "subscription_token"])
        .default("api_key"),
    subscriptionToken: z.string().optional(),
    // Hidden flag: true when editing an existing config. Empty credential
    // then means "keep the existing one" and skips required-field checks.
    isEditing: z.boolean().optional(),
    baseURL: z.url().nullable().optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    maxInputTokens: z.number().int().min(0).nullable().optional(),
    maxConcurrentRequests: z.number().int().min(0).nullable().optional(),
    maxOutputTokens: z.number().int().min(0).nullable().optional(),
    reasoningEffort: z
        .enum(["none", "low", "medium", "high", "custom"])
        .nullable()
        .optional(),
    reasoningConfigOverride: z.string().nullable().optional(),
    openrouterProviderOrder: z.array(z.string()).nullable().optional(),
    openrouterAllowFallbacks: z.boolean().nullable().optional(),
    vertexLocation: z.string().trim().nullable().optional(),
    awsBearerToken: z.string().trim().nullable().optional(),
    awsAccessKeyId: z.string().trim().nullable().optional(),
    awsSecretAccessKey: z.string().trim().nullable().optional(),
    awsRegion: z.string().trim().nullable().optional(),
    awsSessionToken: z.string().trim().nullable().optional(),
};

type SubscriptionRefineData = {
    provider: string;
    subscriptionToken?: string;
};

/**
 * Validates a subscription token's shape for the active provider.
 *
 * - openai (Codex): a raw JWT (`eyJ...`) or the full `~/.codex/auth.json`
 *   JSON containing `tokens.access_token`.
 * - anthropic (Claude Code): a raw `sk-ant-oat01-...` access token, or a
 *   JSON blob (`claudeAiOauth` or top-level) with an `accessToken` of the
 *   same prefix (refreshToken optional, enables auto-renewal).
 *
 * Adds issues on the `subscriptionToken` path; callers decide whether an
 * empty token is allowed (e.g. when editing, empty = keep existing).
 */
function validateSubscriptionToken(
    data: SubscriptionRefineData,
    ctx: z.RefinementCtx,
) {
    const token = data.subscriptionToken?.trim() ?? "";
    if (!token) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Subscription token is required",
            path: ["subscriptionToken"],
        });
        return;
    }

    if (data.provider === "openai") {
        const isJson = token.startsWith("{");
        if (isJson) {
            try {
                const parsed = JSON.parse(token);
                const jwt = parsed?.tokens?.access_token;
                if (!jwt || !jwt.startsWith("eyJ")) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message:
                            "Could not find tokens.access_token in the pasted auth.json",
                        path: ["subscriptionToken"],
                    });
                }
            } catch {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message:
                        "Invalid JSON — paste the full contents of ~/.codex/auth.json",
                    path: ["subscriptionToken"],
                });
            }
        } else if (!token.startsWith("eyJ")) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    "Paste the contents of ~/.codex/auth.json or a JWT starting with eyJ",
                path: ["subscriptionToken"],
            });
        } else if (token.length < 50) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Token looks too short; paste the full id_token value",
                path: ["subscriptionToken"],
            });
        }
    } else if (data.provider === "anthropic") {
        const isJson = token.startsWith("{");
        if (isJson) {
            try {
                const parsed = JSON.parse(token);
                const oauthBlock = parsed?.claudeAiOauth ?? parsed;
                const accessToken = oauthBlock?.accessToken;
                if (
                    !accessToken ||
                    !accessToken.startsWith("sk-ant-oat01-")
                ) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message:
                            "JSON must contain an accessToken starting with sk-ant-oat01-",
                        path: ["subscriptionToken"],
                    });
                }
            } catch {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message:
                        'Invalid JSON — paste {"accessToken": "sk-ant-oat01-...", "refreshToken": "sk-ant-ort01-..."}',
                    path: ["subscriptionToken"],
                });
            }
        } else if (!token.startsWith("sk-ant-oat01-")) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    "Expected token starting with sk-ant-oat01- or a JSON with accessToken + refreshToken",
                path: ["subscriptionToken"],
            });
        } else if (token.length < 80) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    "Token looks too short; paste the full setup-token output",
                path: ["subscriptionToken"],
            });
        }
    }
}

/**
 * Validates Amazon Bedrock credentials: a bearer token is the happy path;
 * otherwise the full IAM access-key + secret pair is required. Surfaces
 * field-specific issues so errors land next to the missing input.
 */
function validateBedrockCredentials(
    data: {
        awsBearerToken?: string | null;
        awsAccessKeyId?: string | null;
        awsSecretAccessKey?: string | null;
    },
    ctx: z.RefinementCtx,
) {
    const hasBearer = !!data.awsBearerToken?.trim();
    const hasAccessKey = !!data.awsAccessKeyId?.trim();
    const hasSecret = !!data.awsSecretAccessKey?.trim();
    const hasAnyIam = hasAccessKey || hasSecret;

    // Happy path: bearer token set → done.
    if (hasBearer) return;

    // User is clearly trying IAM (touched at least one field).
    if (hasAnyIam) {
        if (!hasAccessKey) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["awsAccessKeyId"],
                message: "Access Key ID is required",
            });
        }
        if (!hasSecret) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["awsSecretAccessKey"],
                message: "Secret Access Key is required",
            });
        }
        return;
    }

    // Nothing filled in at all — nudge toward the recommended path.
    ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["awsBearerToken"],
        message:
            "Paste a Bedrock API key, or expand Advanced to use IAM user credentials.",
    });
}

/**
 * Create schema: requires credentials for the active provider.
 * - subscription_token: a valid Claude/Codex token for the provider
 * - amazon_bedrock (api_key): bearer token OR IAM access key + secret
 * - everything else (api_key): apiKey required
 */
export const createKeySchema = z
    .object({
        ...baseFields,
        apiKey: z.string().trim().optional().default(""),
    })
    .superRefine((data, ctx) => {
        if (data.credentialType === "subscription_token") {
            validateSubscriptionToken(data, ctx);
            return;
        }

        if (data.provider === "amazon_bedrock") {
            validateBedrockCredentials(data, ctx);
            return;
        }

        if (!data.apiKey?.trim()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["apiKey"],
                message: "API key is required",
            });
        }
    });

/**
 * Edit schema: an empty credential keeps the existing one. Required-field
 * checks are skipped (api_key / Bedrock), and subscription tokens are only
 * validated for shape when the user actually pastes a new one.
 */
export const editKeySchema = z
    .object({
        ...baseFields,
        apiKey: z.string().trim().optional().default(""),
    })
    .superRefine((data, ctx) => {
        const isEditing = data.isEditing ?? false;

        if (data.credentialType === "subscription_token") {
            const token = data.subscriptionToken?.trim() ?? "";
            // Empty when editing = keep existing token, skip validation.
            if (!token && isEditing) return;
            validateSubscriptionToken(data, ctx);
            return;
        }

        // api_key path. When editing, an empty credential keeps the stored
        // one, so no required-field checks (matches Bedrock masked-secret
        // behavior — fields stay empty unless the user is changing them).
        if (isEditing) return;

        if (data.provider === "amazon_bedrock") {
            validateBedrockCredentials(data, ctx);
            return;
        }

        if (!data.apiKey?.trim()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["apiKey"],
                message: "API key is required",
            });
        }
    });

export type EditKeyForm = z.infer<typeof editKeySchema>;
