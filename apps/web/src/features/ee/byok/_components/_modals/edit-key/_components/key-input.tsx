import { FormControl } from "@components/ui/form-control";
import { Textarea } from "@components/ui/textarea";
import { useSuspenseGetLLMProviders } from "@services/organizationParameters/hooks";
import { ExternalLinkIcon } from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";

import type { EditKeyForm } from "../_types";

export const ByokKeyInput = () => {
    const form = useFormContext<EditKeyForm>();
    const { providers } = useSuspenseGetLLMProviders();

    const provider = form.watch("provider");
    const credentialType = form.watch("credentialType") ?? "api_key";
    const foundProvider = providers.find((p) => p.id === provider);

    if (!foundProvider?.requiresApiKey) return null;

    if (credentialType === "subscription_token") {
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
                                onChange={field.onChange}
                                className="max-h-56 min-h-32 font-mono text-xs"
                                placeholder="sk-ant-oat01-..."
                            />
                        </FormControl.Input>

                        {fieldState.error && (
                            <FormControl.Error>
                                {fieldState.error.message}
                            </FormControl.Error>
                        )}

                        <p className="text-text-tertiary text-xs">
                            Tokens expire after ~8 hours. Re-enter a new token when it expires.
                        </p>
                    </FormControl.Root>
                )}
            />
        );
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
                            placeholder="Provide your key"
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
