"use client";

import { useState } from "react";
import Link from "next/link";
import { Alert, AlertDescription } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { useGetLLMProviderModels } from "@services/organizationParameters/hooks";
import { AlertTriangleIcon, Loader2Icon, SettingsIcon } from "lucide-react";

import curatedCatalog from "../../_data/curated-models.json";
import type { CuratedModel } from "../../_data/curated-models.types";
import type { BYOKConfig } from "../../_types";
import { CuratedConnectPanel } from "./connect-panel";
import { CuratedModelCard } from "./model-card";

export function CuratedCatalog({
    slot,
    existingConfig,
    existingKeyByProvider,
    onSave,
    onCancel,
    showManualLink = true,
}: {
    slot: "main" | "fallback";
    existingConfig?: BYOKConfig;
    existingKeyByProvider?: Partial<Record<string, string>>;
    onSave: (_: BYOKConfig) => Promise<void>;
    onCancel?: () => void;
    showManualLink?: boolean;
}) {
    const [selected, setSelected] = useState<CuratedModel | null>(null);

    const recommended = (curatedCatalog.models as CuratedModel[]).filter(
        (m) => m.tier === "recommended",
    );
    const discoverableProvider = existingConfig?.provider;
    const discoveredQuery = useGetLLMProviderModels({
        provider: discoverableProvider,
        useSavedKey: true,
        enabled: Boolean(existingConfig),
    });
    const visibleIds = new Set(
        recommended.map((model) => `${model.provider}:${model.id}`),
    );
    const discovered = (discoveredQuery.data?.models ?? [])
        .filter(
            (model) => !visibleIds.has(`${discoverableProvider}:${model.id}`),
        )
        .map(
            (model): CuratedModel => ({
                id: model.id,
                displayName: model.name,
                provider: discoverableProvider!,
                providerDisplayName: providerDisplayName(discoverableProvider!),
                tier: "other",
                benchmarkScore: 0,
                description: `Available for your saved ${providerDisplayName(discoverableProvider!)} configuration.`,
                speed: "medium",
                contextWindow: "Provider-defined",
                costTier: "$$$",
                strengths: [],
                weaknesses: [],
                apiKeyUrl: providerApiKeyUrl(discoverableProvider!),
                defaults: {
                    temperature: 0,
                    maxOutputTokens: 16384,
                    reasoningEffort: "medium",
                },
                discovered: true,
            }),
        );

    if (selected) {
        return (
            <CuratedConnectPanel
                model={selected}
                existingConfig={
                    existingConfig?.provider === selected.provider
                        ? existingConfig
                        : undefined
                }
                existingKey={existingKeyByProvider?.[selected.provider]}
                onBack={() => setSelected(null)}
                onSave={onSave}
            />
        );
    }

    return (
        <div className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {recommended.map((model) => (
                    <CuratedModelCard
                        key={model.id}
                        model={model}
                        onSelect={() => setSelected(model)}
                    />
                ))}
            </div>

            {existingConfig && (
                <section className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <h4 className="text-text-primary text-sm font-semibold">
                                Available for your{" "}
                                {providerDisplayName(existingConfig.provider)}{" "}
                                configuration
                            </h4>
                            <p className="text-text-tertiary text-xs">
                                Loaded from the provider catalog using your
                                saved credential.
                            </p>
                        </div>
                        {discoveredQuery.isFetching && (
                            <Loader2Icon className="text-text-secondary size-4 animate-spin" />
                        )}
                    </div>

                    {discoveredQuery.isError ? (
                        <Alert variant="warning">
                            <AlertTriangleIcon />
                            <AlertDescription>
                                The provider model catalog could not be loaded.
                                Reconnect your credential or use manual
                                configuration.
                            </AlertDescription>
                        </Alert>
                    ) : discovered.length > 0 ? (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {discovered.map((model) => (
                                <CuratedModelCard
                                    key={`${model.provider}:${model.id}`}
                                    model={model}
                                    compact
                                    onSelect={() => setSelected(model)}
                                />
                            ))}
                        </div>
                    ) : !discoveredQuery.isFetching ? (
                        <p className="text-text-tertiary text-xs">
                            All models returned by the provider are already
                            shown above.
                        </p>
                    ) : null}
                </section>
            )}

            <div className="border-card-lv2 flex items-center justify-between gap-4 border-t pt-5">
                {showManualLink ? (
                    <p className="text-text-secondary text-xs text-pretty">
                        Need a provider or model not listed above?
                    </p>
                ) : (
                    <span />
                )}

                <div className="flex items-center gap-2">
                    {onCancel && (
                        <Button
                            type="button"
                            size="sm"
                            variant="cancel"
                            onClick={onCancel}>
                            Cancel
                        </Button>
                    )}
                    {showManualLink && (
                        <Link href={`/organization/byok/manual?slot=${slot}`}>
                            <Button
                                type="button"
                                size="sm"
                                variant="helper"
                                leftIcon={<SettingsIcon />}>
                                Configure manually
                            </Button>
                        </Link>
                    )}
                </div>
            </div>
        </div>
    );
}

const providerDisplayName = (provider: string): string => {
    const labels: Record<string, string> = {
        openai: "OpenAI",
        anthropic: "Anthropic",
        google_gemini: "Google Gemini",
        openrouter: "OpenRouter",
    };
    return labels[provider] ?? provider;
};

const providerApiKeyUrl = (provider: string): string => {
    const urls: Record<string, string> = {
        openai: "https://platform.openai.com/api-keys",
        anthropic: "https://console.anthropic.com/settings/keys",
        google_gemini: "https://aistudio.google.com/app/apikey",
        openrouter: "https://openrouter.ai/settings/keys",
    };
    return urls[provider] ?? "";
};
