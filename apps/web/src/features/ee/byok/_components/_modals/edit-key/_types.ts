import { z } from "zod";

const baseFields = {
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    credentialType: z
        .enum(["api_key", "subscription_token"])
        .default("api_key"),
    apiKey: z.string().optional(),
    subscriptionToken: z.string().optional(),
    baseURL: z.url().nullable().optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    maxInputTokens: z.number().int().min(0).nullable().optional(),
    maxConcurrentRequests: z.number().int().min(0).nullable().optional(),
    maxOutputTokens: z.number().int().min(0).nullable().optional(),
    // Hidden flag: true when editing an existing config (empty credential = keep existing)
    isEditing: z.boolean().optional(),
};

export const createKeySchema = z
    .object(baseFields)
    .superRefine((data, ctx) => {
        if (data.credentialType === "api_key" && !data.apiKey?.trim()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "API Key is required",
                path: ["apiKey"],
            });
        }
        if (data.credentialType === "subscription_token") {
            const token = data.subscriptionToken?.trim() ?? "";
            if (!token) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "Subscription token is required",
                    path: ["subscriptionToken"],
                });
            } else if (data.provider === "openai") {
                const isJson = token.startsWith("{");
                if (isJson) {
                    try {
                        const parsed = JSON.parse(token);
                        const jwt = parsed?.tokens?.access_token;
                        if (!jwt || !jwt.startsWith("eyJ")) {
                            ctx.addIssue({
                                code: z.ZodIssueCode.custom,
                                message: "Could not find tokens.access_token in the pasted auth.json",
                                path: ["subscriptionToken"],
                            });
                        }
                    } catch {
                        ctx.addIssue({
                            code: z.ZodIssueCode.custom,
                            message: "Invalid JSON — paste the full contents of ~/.codex/auth.json",
                            path: ["subscriptionToken"],
                        });
                    }
                } else if (!token.startsWith("eyJ")) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "Paste the contents of ~/.codex/auth.json or a JWT starting with eyJ",
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
                        const accessToken = parsed?.accessToken;
                        if (!accessToken || !accessToken.startsWith("sk-ant-oat01-")) {
                            ctx.addIssue({
                                code: z.ZodIssueCode.custom,
                                message: "JSON must contain an accessToken starting with sk-ant-oat01-",
                                path: ["subscriptionToken"],
                            });
                        }
                    } catch {
                        ctx.addIssue({
                            code: z.ZodIssueCode.custom,
                            message: 'Invalid JSON — paste {"accessToken": "sk-ant-oat01-...", "refreshToken": "sk-ant-ort01-..."}',
                            path: ["subscriptionToken"],
                        });
                    }
                } else if (!token.startsWith("sk-ant-oat01-")) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "Expected token starting with sk-ant-oat01- or a JSON with accessToken + refreshToken",
                        path: ["subscriptionToken"],
                    });
                } else if (token.length < 80) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "Token looks too short; paste the full setup-token output",
                        path: ["subscriptionToken"],
                    });
                }
            }
        }
    });

export const editKeySchema = z
    .object(baseFields)
    .superRefine((data, ctx) => {
        const isEditing = data.isEditing ?? false;

        if (data.credentialType === "api_key" && !data.apiKey?.trim()) {
            if (!isEditing) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "API Key is required",
                    path: ["apiKey"],
                });
            }
        }
        if (data.credentialType === "subscription_token") {
            const token = data.subscriptionToken?.trim() ?? "";
            // Empty when editing = keep existing token, skip validation
            if (!token && isEditing) return;
            if (!token) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: "Subscription token is required",
                    path: ["subscriptionToken"],
                });
            } else if (data.provider === "openai") {
                const isJson = token.startsWith("{");
                if (isJson) {
                    try {
                        const parsed = JSON.parse(token);
                        const jwt = parsed?.tokens?.access_token;
                        if (!jwt || !jwt.startsWith("eyJ")) {
                            ctx.addIssue({
                                code: z.ZodIssueCode.custom,
                                message: "Could not find tokens.access_token in the pasted auth.json",
                                path: ["subscriptionToken"],
                            });
                        }
                    } catch {
                        ctx.addIssue({
                            code: z.ZodIssueCode.custom,
                            message: "Invalid JSON — paste the full contents of ~/.codex/auth.json",
                            path: ["subscriptionToken"],
                        });
                    }
                } else if (!token.startsWith("eyJ")) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "Paste the contents of ~/.codex/auth.json or a JWT starting with eyJ",
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
                        const accessToken = parsed?.accessToken;
                        if (!accessToken || !accessToken.startsWith("sk-ant-oat01-")) {
                            ctx.addIssue({
                                code: z.ZodIssueCode.custom,
                                message: "JSON must contain an accessToken starting with sk-ant-oat01-",
                                path: ["subscriptionToken"],
                            });
                        }
                    } catch {
                        ctx.addIssue({
                            code: z.ZodIssueCode.custom,
                            message: 'Invalid JSON — paste {"accessToken": "sk-ant-oat01-...", "refreshToken": "sk-ant-ort01-..."}',
                            path: ["subscriptionToken"],
                        });
                    }
                } else if (!token.startsWith("sk-ant-oat01-")) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "Expected token starting with sk-ant-oat01- or a JSON with accessToken + refreshToken",
                        path: ["subscriptionToken"],
                    });
                } else if (token.length < 80) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "Token looks too short; paste the full setup-token output",
                        path: ["subscriptionToken"],
                    });
                }
            }
        }
    });

export type EditKeyForm = z.infer<typeof editKeySchema>;
