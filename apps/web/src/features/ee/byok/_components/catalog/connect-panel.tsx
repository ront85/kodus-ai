"use client";

import { Suspense, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { zodResolver } from "@hookform/resolvers/zod";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import {
    testBYOK,
    type TestBYOKResult,
} from "@services/organizationParameters/fetch";
import {
    ArrowLeftIcon,
    CheckCircle2Icon,
    ExternalLinkIcon,
    PlugIcon,
    SaveIcon,
    XCircleIcon,
} from "lucide-react";
import { FormProvider, useForm } from "react-hook-form";

import { ByokAdvancedSettings } from "../_modals/edit-key/_components/advanced-settings";
import { CredentialTypeToggle } from "../_modals/edit-key/_components/credential-type-toggle";
import { ByokKeyInput } from "../_modals/edit-key/_components/key-input";
import {
    createKeySchema,
    editKeySchema,
    type EditKeyForm,
} from "../_modals/edit-key/_types";
import type {
    CuratedModel,
    ModelVariant,
} from "../../_data/curated-models.types";
import type { BYOKConfig } from "../../_types";
import { CuratedModelCard, PROVIDER_LABELS } from "./model-card";

const resolveInitialVariant = (
    model: CuratedModel,
    existingBaseURL?: string,
): ModelVariant | undefined => {
    if (!model.variants?.length) return undefined;
    if (existingBaseURL) {
        const byUrl = model.variants.find((v) => v.baseURL === existingBaseURL);
        if (byUrl) return byUrl;
    }
    const byDefault = model.defaultVariantId
        ? model.variants.find((v) => v.id === model.defaultVariantId)
        : undefined;
    return byDefault ?? model.variants[0];
};

export function CuratedConnectPanel({
    model,
    existingConfig,
    existingKey,
    onBack,
    onSave,
}: {
    model: CuratedModel;
    existingConfig?: BYOKConfig;
    existingKey?: string;
    onBack: () => void;
    onSave: (_: BYOKConfig) => Promise<void>;
}) {
    const [testState, setTestState] = useState<
        | { status: "idle" }
        | { status: "testing" }
        | { status: "success"; latencyMs: number }
        | { status: "error"; result: TestBYOKResult }
    >({ status: "idle" });
    const [isSaving, setIsSaving] = useState(false);
    const [variant, setVariant] = useState<ModelVariant | undefined>(() =>
        resolveInitialVariant(model, existingConfig?.baseURL),
    );
    const hasStoredCredential = Boolean(existingConfig || existingKey);

    const initialBaseURL =
        existingConfig?.baseURL ??
        variant?.baseURL ??
        model.defaults.baseURL ??
        null;
    const initialMaxConcurrent =
        existingConfig?.maxConcurrentRequests ??
        variant?.maxConcurrentRequests ??
        null;

    // When a key is already stored, blank credentials mean "keep the current
    // one" — that's the editKeySchema's `isEditing` semantics (applies to both
    // api_key and subscription_token). A fresh connection requires credentials.
    const form = useForm<EditKeyForm>({
        mode: "onChange",
        resolver: zodResolver(
            hasStoredCredential ? editKeySchema : createKeySchema,
        ) as any,
        defaultValues: {
            provider: variant?.provider ?? model.provider,
            model: model.id,
            credentialType: existingConfig?.credentialType ?? "api_key",
            apiKey: "",
            subscriptionToken: "",
            isEditing: hasStoredCredential,
            baseURL: initialBaseURL,
            temperature:
                existingConfig?.temperature ?? model.defaults.temperature,
            maxOutputTokens:
                existingConfig?.maxOutputTokens ??
                model.defaults.maxOutputTokens,
            maxInputTokens: existingConfig?.maxInputTokens ?? null,
            maxConcurrentRequests: initialMaxConcurrent,
            reasoningEffort: existingConfig?.reasoningConfigOverride
                ? "custom"
                : (existingConfig?.reasoningEffort ??
                  model.defaults.reasoningEffort ??
                  null),
            reasoningConfigOverride:
                existingConfig?.reasoningConfigOverride ?? null,
            openrouterProviderOrder:
                existingConfig?.openrouterProviderOrder ?? null,
            openrouterAllowFallbacks:
                existingConfig?.openrouterAllowFallbacks ?? null,
        },
    });

    const activeBaseURL = variant?.baseURL ?? model.defaults.baseURL;
    const activeApiKeyUrl = variant?.apiKeyUrl ?? model.apiKeyUrl;

    const disabledVariants = new Set<string>([]);

    const handleVariantChange = (nextId: string) => {
        if (!nextId || !model.variants || disabledVariants.has(nextId)) return;
        const next = model.variants.find((v) => v.id === nextId);
        if (!next || next.id === variant?.id) return;
        setVariant(next);
        form.setValue("provider", next.provider ?? model.provider, {
            shouldValidate: true,
            shouldDirty: true,
        });
        form.setValue("baseURL", next.baseURL, {
            shouldValidate: true,
            shouldDirty: true,
        });
        form.setValue(
            "maxConcurrentRequests",
            next.maxConcurrentRequests ?? null,
            { shouldDirty: true },
        );
        if (testState.status !== "idle") setTestState({ status: "idle" });
    };

    const { isValid } = form.formState;
    const credentialType = form.watch("credentialType") ?? "api_key";
    const apiKey = form.watch("apiKey");
    const subscriptionToken = form.watch("subscriptionToken");

    // A credential is "ready" when the relevant field has content, or when a
    // key is already stored (blank = keep the existing one).
    const hasCredential =
        hasStoredCredential ||
        (credentialType === "subscription_token"
            ? !!subscriptionToken?.trim()
            : !!apiKey?.trim());

    // Editing any credential field (or switching credential type) invalidates a
    // previous Test result. The bespoke Textarea used to do this inline; the
    // shared ByokKeyInput doesn't, so reset the panel banner here instead.
    useEffect(() => {
        setTestState((prev) =>
            prev.status === "idle" ? prev : { status: "idle" },
        );
    }, [apiKey, subscriptionToken, credentialType]);

    const buildConfig = (data: EditKeyForm): BYOKConfig => {
        const effort = data.reasoningEffort;
        const isSubscription = data.credentialType === "subscription_token";
        return {
            provider: data.provider,
            model: data.model,
            credentialType: data.credentialType,
            // Only one credential travels with the config; clear the other so a
            // stale value from a toggle flip never reaches the backend.
            apiKey: isSubscription ? undefined : data.apiKey || undefined,
            subscriptionToken: isSubscription
                ? data.subscriptionToken || undefined
                : undefined,
            baseURL: data.baseURL || undefined,
            temperature: data.temperature ?? undefined,
            maxInputTokens: data.maxInputTokens ?? undefined,
            maxConcurrentRequests: data.maxConcurrentRequests ?? undefined,
            maxOutputTokens: data.maxOutputTokens ?? undefined,
            reasoningEffort:
                effort === "custom" || !effort ? undefined : effort,
            reasoningConfigOverride:
                effort === "custom"
                    ? (data.reasoningConfigOverride ?? undefined)
                    : undefined,
            openrouterProviderOrder:
                data.provider === "open_router" &&
                data.openrouterProviderOrder &&
                data.openrouterProviderOrder.length > 0
                    ? data.openrouterProviderOrder
                    : undefined,
            openrouterAllowFallbacks:
                data.provider === "open_router" &&
                typeof data.openrouterAllowFallbacks === "boolean"
                    ? data.openrouterAllowFallbacks
                    : undefined,
        };
    };

    const runTest = async (): Promise<TestBYOKResult | null> => {
        const valid = await form.trigger();
        if (!valid) return null;

        const data = form.getValues();

        // Subscription tokens are verified through the dedicated
        // /test-credential route (the SubscriptionTokenInput's own "Test token"
        // button). The api-key probe used here (/test-byok) can't validate
        // OAuth/Codex tokens, so the panel-level Test/Save just trusts the
        // Zod-validated token and proceeds to save.
        if (
            data.credentialType === "subscription_token" ||
            (hasStoredCredential && !data.apiKey?.trim())
        ) {
            setTestState({ status: "idle" });
            return { ok: true, code: "ok", latencyMs: 0 };
        }

        setTestState({ status: "testing" });

        try {
            const result = await testBYOK({
                provider: data.provider,
                apiKey: data.apiKey!,
                baseURL: data.baseURL ?? undefined,
                model: data.model,
            });

            if (result.ok) {
                setTestState({
                    status: "success",
                    latencyMs: result.latencyMs,
                });
            } else {
                setTestState({ status: "error", result });
            }
            return result;
        } catch {
            const result: TestBYOKResult = {
                ok: false,
                code: "unknown",
                latencyMs: 0,
                message: "Couldn't reach Kodus. Try again in a moment.",
            };
            setTestState({ status: "error", result });
            return result;
        }
    };

    const handleTestAndSave = async () => {
        const result = await runTest();
        if (!result?.ok) return;

        setIsSaving(true);
        try {
            await onSave(buildConfig(form.getValues()));
        } finally {
            setIsSaving(false);
        }
    };

    const providerLabel =
        model.providerDisplayName ??
        PROVIDER_LABELS[model.provider] ??
        model.provider;

    const testing = testState.status === "testing";

    return (
        <FormProvider {...form}>
            <Card color="lv1">
                <CardHeader className="flex-row items-start justify-between gap-4">
                    <Button
                        type="button"
                        size="xs"
                        variant="cancel"
                        leftIcon={<ArrowLeftIcon />}
                        onClick={onBack}>
                        Choose another model
                    </Button>
                </CardHeader>

                <CardContent className="flex flex-col gap-5">
                    <CuratedModelCard model={model} isSelected />

                    {model.variants && model.variants.length > 0 && (
                        <VariantSelector
                            variants={model.variants}
                            selectedId={variant?.id}
                            docsUrl={model.docsUrl}
                            onSelect={handleVariantChange}
                            disabledVariantIds={disabledVariants}
                        />
                    )}

                    {hasStoredCredential && (
                        <Alert variant="info">
                            <AlertDescription className="text-pretty">
                                A key for <strong>{providerLabel}</strong> is
                                already stored. Paste a new one to replace it —
                                or leave blank to keep the current key while you
                                switch models or tweak advanced settings.
                            </AlertDescription>
                        </Alert>
                    )}

                    {/* CredentialTypeToggle + ByokKeyInput both read the live
                        providers list via useSuspenseGetLLMProviders, so they
                        need a Suspense ancestor (this catalog tree has none).
                        They share the one query, so they suspend together. */}
                    <Suspense
                        fallback={
                            <div className="bg-card-lv2 h-32 animate-pulse rounded-md" />
                        }>
                        {/* Providers that support subscription tokens
                            (anthropic, openai) get the toggle;
                            CredentialTypeToggle self-hides for every other
                            provider, leaving the plain api-key input untouched. */}
                        <div className="flex flex-col gap-3">
                            <CredentialTypeToggle />

                            {/* ByokKeyInput switches on credentialType: the
                                api-key textarea for "api_key", the subscription
                                token + setup instructions for
                                "subscription_token". */}
                            <ByokKeyInput />
                        </div>
                    </Suspense>

                    {/* Preserve the curated panel's "Get a key" / endpoint
                        helper — but only for the api-key path, since the
                        subscription input renders its own setup guidance. */}
                    {credentialType === "api_key" && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <a
                                href={activeApiKeyUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary-light inline-flex items-center gap-1 text-xs hover:underline">
                                Get a key from {providerLabel}
                                {variant ? ` (${variant.label})` : ""}
                                <ExternalLinkIcon size={12} />
                            </a>
                            {activeBaseURL && (
                                <span className="text-text-tertiary text-xs">
                                    Endpoint:{" "}
                                    <code className="bg-card-lv2 rounded px-1 py-0.5 font-mono text-[11px]">
                                        {activeBaseURL}
                                    </code>
                                </span>
                            )}
                        </div>
                    )}

                    <TestResultBanner state={testState} />

                    <ByokAdvancedSettings
                        defaultOpen={!!model.variants?.length}
                    />

                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                            type="button"
                            size="md"
                            variant="cancel"
                            onClick={onBack}>
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            size="md"
                            variant="helper"
                            leftIcon={<PlugIcon />}
                            loading={testing}
                            disabled={!isValid || !hasCredential || isSaving}
                            onClick={() => {
                                void runTest();
                            }}>
                            Test
                        </Button>
                        <Button
                            type="button"
                            size="md"
                            variant="primary"
                            leftIcon={<SaveIcon />}
                            loading={testing || isSaving}
                            disabled={!isValid || !hasCredential}
                            onClick={() => {
                                void handleTestAndSave();
                            }}>
                            {existingKey && !apiKey?.trim() ? (
                                "Save"
                            ) : (
                                <>Test &amp; save</>
                            )}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </FormProvider>
    );
}

function VariantSelector({
    variants,
    selectedId,
    docsUrl,
    onSelect,
    disabledVariantIds,
}: {
    variants: ModelVariant[];
    selectedId?: string;
    docsUrl?: string;
    onSelect: (id: string) => void;
    disabledVariantIds?: Set<string>;
}) {
    const selected = variants.find((v) => v.id === selectedId);
    const isDisabledVariant = (id: string) => disabledVariantIds?.has(id);

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
                <span className="text-text-secondary text-xs font-medium">
                    Plan
                </span>
                {docsUrl && (
                    <a
                        href={docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary-light inline-flex items-center gap-1 text-xs hover:underline">
                        Which plan do I pick?
                        <ExternalLinkIcon size={11} />
                    </a>
                )}
            </div>
            <ToggleGroup.Root
                type="single"
                value={selectedId}
                onValueChange={(nextId) => {
                    if (nextId && isDisabledVariant(nextId)) return;
                    onSelect(nextId);
                }}
                className="bg-card-lv2 grid auto-cols-fr grid-flow-col gap-px overflow-hidden rounded-lg p-0.5">
                {variants.map((v) => (
                    <ToggleGroup.Item
                        key={v.id}
                        value={v.id}
                        disabled={isDisabledVariant(v.id)}
                        className="text-text-secondary hover:text-text-primary data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:ring-primary/40 rounded-md px-3 py-2 text-xs font-medium transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[state=on]:shadow-sm data-[state=on]:ring-1">
                        {v.label}
                        {isDisabledVariant(v.id) && (
                            <span className="ml-1.5 text-xs">
                                (Coming Soon)
                            </span>
                        )}
                    </ToggleGroup.Item>
                ))}
            </ToggleGroup.Root>
            {selected?.description && !isDisabledVariant(selected.id) && (
                <p className="text-text-tertiary text-xs text-pretty">
                    {selected.description}
                </p>
            )}
        </div>
    );
}

function TestResultBanner({
    state,
}: {
    state:
        | { status: "idle" }
        | { status: "testing" }
        | { status: "success"; latencyMs: number }
        | { status: "error"; result: TestBYOKResult };
}) {
    if (state.status === "idle" || state.status === "testing") return null;

    if (state.status === "success") {
        return (
            <Alert variant="success">
                <CheckCircle2Icon />
                <AlertDescription className="text-pretty">
                    Connection OK — provider responded in{" "}
                    <span className="tabular-nums">{state.latencyMs}ms</span>.
                </AlertDescription>
            </Alert>
        );
    }

    return <TestErrorBanner result={state.result} />;
}

function TestErrorBanner({ result }: { result: TestBYOKResult }) {
    const headline = (() => {
        switch (result.code) {
            case "auth":
                return "Invalid API key";
            case "not_found":
                return "Endpoint not found";
            case "bad_request":
                return "Request rejected by provider";
            case "payment":
                return "Insufficient balance or inactive billing";
            case "rate_limit":
                return "Rate limited";
            case "server_error":
                return "Provider is having issues";
            case "network":
                return "Couldn't reach the provider";
            default:
                return "Connection failed";
        }
    })();

    return (
        <Alert variant="danger">
            <XCircleIcon />
            <AlertDescription className="flex flex-col gap-2 text-pretty">
                <span className="text-text-primary font-semibold">
                    {headline}
                    {result.httpStatus ? (
                        <span className="text-text-secondary ml-2 font-normal tabular-nums">
                            · HTTP {result.httpStatus}
                        </span>
                    ) : null}
                </span>
                {result.message && <span>{result.message}</span>}
                {result.providerMessage && (
                    <span className="bg-card-lv2 text-text-secondary block rounded-md px-2.5 py-1.5 font-mono text-xs break-words">
                        <span className="text-text-tertiary mr-1">
                            Provider said:
                        </span>
                        {result.providerMessage}
                    </span>
                )}
            </AlertDescription>
        </Alert>
    );
}
