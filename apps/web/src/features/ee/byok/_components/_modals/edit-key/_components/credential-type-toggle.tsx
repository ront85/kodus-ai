import { Button } from "@components/ui/button";
import { useSuspenseGetLLMProviders } from "@services/organizationParameters/hooks";
import { useFormContext } from "react-hook-form";

import type { EditKeyForm } from "../_types";

export const CredentialTypeToggle = () => {
    const form = useFormContext<EditKeyForm>();
    const { providers } = useSuspenseGetLLMProviders();

    const provider = form.watch("provider");
    const credentialType = form.watch("credentialType");

    const foundProvider = providers.find((p) => p.id === provider);
    if (!foundProvider?.supportsSubscriptionToken) return null;

    const handleSelect = (value: "api_key" | "subscription_token") => {
        form.setValue("credentialType", value, { shouldValidate: true });
        if (value === "api_key") {
            form.setValue("subscriptionToken", "", { shouldValidate: false });
        } else {
            form.setValue("apiKey", "", { shouldValidate: false });
        }
    };

    return (
        <div className="flex gap-1 rounded-md border border-border p-1">
            <Button
                type="button"
                size="sm"
                variant={
                    credentialType === "api_key" ? "primary" : "cancel"
                }
                className="flex-1"
                onClick={() => handleSelect("api_key")}>
                API Key
            </Button>
            <Button
                type="button"
                size="sm"
                variant={
                    credentialType === "subscription_token"
                        ? "primary"
                        : "cancel"
                }
                className="flex-1"
                onClick={() => handleSelect("subscription_token")}>
                Subscription Token
            </Button>
        </div>
    );
};
