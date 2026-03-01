import { useState } from "react";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Textarea } from "@components/ui/textarea";
import { ORGANIZATION_PARAMETERS_PATHS } from "@services/organizationParameters";
import { useSuspenseGetLLMProviders } from "@services/organizationParameters/hooks";
import { ExternalLinkIcon, FlaskConicalIcon, Loader2Icon, CheckCircleIcon, XCircleIcon } from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";
import { axiosAuthorized } from "src/core/utils/axios";

import type { EditKeyForm } from "../_types";

type TestResult = { status: "idle" } | { status: "loading" } | { status: "success"; message: string } | { status: "error"; message: string };

export const ByokKeyInput = () => {
    const form = useFormContext<EditKeyForm>();
    const { providers } = useSuspenseGetLLMProviders();

    const provider = form.watch("provider");
    const credentialType = form.watch("credentialType") ?? "api_key";
    const isEditing = form.watch("isEditing") ?? false;
    const foundProvider = providers.find((p) => p.id === provider);

    if (!foundProvider?.requiresApiKey) return null;

    if (credentialType === "subscription_token") {
        return <SubscriptionTokenInput provider={provider} isEditing={isEditing} foundProvider={foundProvider} />;
    }

    return (
        <Controller
            name="apiKey"
            control={form.control}
            render={({ field, fieldState }) => (
                <FormControl.Root>
                    <FormControl.Label htmlFor={field.name}>
                        API Key
                    </FormControl.Label>

                    <FormControl.Input>
                        <Textarea
                            id={field.name}
                            value={field.value ?? ""}
                            onChange={field.onChange}
                            className="max-h-56 min-h-32"
                            placeholder={isEditing ? "Already configured — paste a new key to replace" : "Provide your key"}
                        />
                    </FormControl.Input>

                    {fieldState.error && (
                        <FormControl.Error>
                            {fieldState.error.message}
                        </FormControl.Error>
                    )}
                </FormControl.Root>
            )}
        />
    );
};

const SubscriptionTokenInput = ({
    provider,
    isEditing,
    foundProvider,
}: {
    provider: string;
    isEditing: boolean;
    foundProvider: {
        subscriptionTokenInstructions?: string;
        subscriptionTokenSetupUrl?: string;
    };
}) => {
    const form = useFormContext<EditKeyForm>();
    const [testResult, setTestResult] = useState<TestResult>({ status: "idle" });

    const handleTest = async () => {
        const token = form.getValues("subscriptionToken")?.trim();
        if (!token && !isEditing) return;

        setTestResult({ status: "loading" });
        try {
            const res = await axiosAuthorized.post<{ success: boolean; message: string }>(
                ORGANIZATION_PARAMETERS_PATHS.TEST_CREDENTIAL,
                {
                    provider,
                    credentialType: "subscription_token",
                    ...(token ? { subscriptionToken: token } : {}),
                },
            );
            const data = res.data;
            setTestResult(
                data.success
                    ? { status: "success", message: data.message }
                    : { status: "error", message: data.message },
            );
        } catch (err: any) {
            setTestResult({
                status: "error",
                message: err?.response?.data?.message || err?.message || "Test request failed",
            });
        }
    };

    return (
        <Controller
            name="subscriptionToken"
            control={form.control}
            render={({ field, fieldState }) => (
                <FormControl.Root>
                    {foundProvider.subscriptionTokenInstructions && (
                        <div className="bg-card-lv2 text-text-secondary rounded-md p-3 text-xs">
                            <p className="font-medium mb-1.5">How to get your token:</p>
                            {foundProvider.subscriptionTokenInstructions
                                .split("\n")
                                .map((line, i) => (
                                    <p key={i} className={line === "" ? "mt-2" : "leading-relaxed"}>
                                        {line.startsWith("Run:") ? (
                                            <>Run: <code className="bg-card-lv3 rounded px-1 font-mono">{line.replace(/^Run:\s*/, "")}</code></>
                                        ) : line}
                                    </p>
                                ))}
                            {foundProvider.subscriptionTokenSetupUrl && (
                                <a
                                    href={foundProvider.subscriptionTokenSetupUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary mt-2 inline-flex items-center gap-1 underline">
                                    View setup docs
                                    <ExternalLinkIcon className="h-3 w-3" />
                                </a>
                            )}
                        </div>
                    )}

                    <FormControl.Label htmlFor={field.name}>
                        OAuth Token
                    </FormControl.Label>

                    <FormControl.Input>
                        <Textarea
                            id={field.name}
                            value={field.value ?? ""}
                            onChange={(e) => {
                                field.onChange(e);
                                if (testResult.status !== "idle") setTestResult({ status: "idle" });
                            }}
                            className="max-h-56 min-h-32 font-mono text-xs"
                            placeholder={isEditing ? "Already configured — paste new auth.json contents to replace" : provider === "openai" ? 'Paste contents of ~/.codex/auth.json (or a raw eyJ... JWT)' : "sk-ant-oat01-..."}
                        />
                    </FormControl.Input>

                    {fieldState.error && (
                        <FormControl.Error>
                            {fieldState.error.message}
                        </FormControl.Error>
                    )}

                    <div className="flex items-center gap-2 mt-1">
                        <Button
                            type="button"
                            variant="tertiary"
                            size="xs"
                            disabled={(!field.value?.trim() && !isEditing) || testResult.status === "loading"}
                            leftIcon={
                                testResult.status === "loading"
                                    ? <Loader2Icon className="h-3 w-3 animate-spin" />
                                    : <FlaskConicalIcon className="h-3 w-3" />
                            }
                            onClick={handleTest}>
                            {testResult.status === "loading" ? "Testing..." : field.value?.trim() ? "Test token" : "Test saved token"}
                        </Button>

                        {testResult.status === "success" && (
                            <span className="text-success inline-flex items-center gap-1 text-xs">
                                <CheckCircleIcon className="h-3.5 w-3.5" />
                                {testResult.message}
                            </span>
                        )}
                        {testResult.status === "error" && (
                            <span className="text-danger inline-flex items-center gap-1 text-xs">
                                <XCircleIcon className="h-3.5 w-3.5" />
                                {testResult.message}
                            </span>
                        )}
                    </div>

                    <p className="text-text-tertiary text-xs">
                        {provider === "openai"
                            ? "Tokens expire after ~10 days. Re-run codex login and paste the updated auth.json when expired."
                            : "Tokens expire after ~8 hours. Re-enter a new token when it expires."}
                    </p>
                </FormControl.Root>
            )}
        />
    );
};
