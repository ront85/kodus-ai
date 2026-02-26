import { Button } from "@components/ui/button";
import { CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Switch } from "@components/ui/switch";
import { useGetE2BIp } from "@services/globalParameters/hooks";
import { Controller, useFormContext } from "react-hook-form";

import { OverrideIndicatorForm } from "../../../_components/override";
import type { CodeReviewFormType } from "../../../_types";

export const CrossfileDependenciesAnalysis = () => {
    const form = useFormContext<CodeReviewFormType>();
    const { data: e2bParam } = useGetE2BIp();
    const ip = e2bParam?.ip;

    return (
        <Controller
            name="crossFileDependenciesAnalysis.value"
            control={form.control}
            render={({ field }) => (
                <Button
                    size="sm"
                    variant="helper"
                    className="w-full"
                    onClick={() => field.onChange(!field.value)}>
                    <CardHeader className="flex-row items-center justify-between gap-6">
                        <div className="flex flex-col gap-1">
                            <div className="flex flex-row items-center gap-2">
                                <Heading variant="h3">
                                    Enable Crossfile Dependencies Analysis
                                </Heading>

                                <OverrideIndicatorForm fieldName="crossFileDependenciesAnalysis" />
                            </div>

                            <p className="text-text-secondary text-sm">
                                When enabled, Kody will fetch cross-file
                                dependencies based on PR changes.
                            </p>

                            {field.value && ip && (
                                <p className="text-warning-foreground text-xs font-medium">
                                    If your Git tool has IP restrictions,
                                    you&apos;ll need to whitelist the E2B IP:{" "}
                                    {ip}
                                </p>
                            )}
                        </div>

                        <Switch decorative checked={field.value} />
                    </CardHeader>
                </Button>
            )}
        />
    );
};
