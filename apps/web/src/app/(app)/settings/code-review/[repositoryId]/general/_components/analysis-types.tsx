"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import {
    useGetAllCodeReviewLabels,
    useGetCodeReviewLabels,
} from "@services/parameters/hooks";
import type { CodeReviewLabel } from "@services/parameters/types";
import { Controller, useFormContext } from "react-hook-form";
import { safeArray } from "src/core/utils/safe-array";
import { useCurrentConfigLevel } from "src/app/(app)/settings/_hooks";
import { Settings2Icon } from "lucide-react";

import { FormattedConfigLevel, type CodeReviewFormType } from "../../../_types";
import { OverrideIndicatorForm } from "../../../_components/override";
import { SkillEditorModal } from "./skill-editor-modal";

/**
 * Maps a review category type to its configurable skill.
 * Add an entry here whenever a new category becomes skill-powered.
 */
const CATEGORY_SKILLS: Record<string, { skillName: string }> = {
    business_logic: { skillName: "business-rules-validation" },
};

interface CheckboxCardOption {
    value: string;
    name: string;
    description: string;
}

export const AnalysisTypes = () => {
    const currentLevel = useCurrentConfigLevel();
    const form = useFormContext<CodeReviewFormType>();
    const [configuringCategory, setConfiguringCategory] = useState<string | null>(null);
    const codeReviewVersion = form.watch("codeReviewVersion.value") || "v2";
    const { data: labels = [], isLoading } =
        useGetCodeReviewLabels(codeReviewVersion);
    const { isLoading: allLabelsLoading, allLabels } =
        useGetAllCodeReviewLabels();
    const initializedRef = useRef(false);

    // Merge all categories ensuring boolean values - keep user's existing values
    useEffect(() => {
        if (
            allLabels.length > 0 &&
            !allLabelsLoading &&
            !initializedRef.current
        ) {
            const currentOptions = form.getValues("reviewOptions") || {};
            const mergedOptions = { ...currentOptions };

            // Add all categories from both versions with their current values or false as default
            allLabels.forEach((label) => {
                if (!mergedOptions[label.type]) {
                    mergedOptions[label.type] = {
                        value: false,
                        level: FormattedConfigLevel.DEFAULT,
                    };
                }
            });

            form.setValue("reviewOptions", mergedOptions);
            initializedRef.current = true;
        }
    }, [allLabels.length, allLabelsLoading, form]); // Only run once when labels are loaded

    const reviewOptionsOptions: CheckboxCardOption[] = safeArray<CodeReviewLabel>(labels).map(
        (label) => ({
            value: label.type,
            name: label.name,
            description: label.description,
        }),
    );

    if (isLoading || allLabelsLoading) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="text-text-secondary">Loading categories...</div>
            </div>
        );
    }

    return (
        <>
        <Controller
            name="reviewOptions"
            control={form.control}
            render={({ field }) => (
                <FormControl.Root className="@container space-y-1">
                    <FormControl.Input>
                        <ToggleGroup.Root
                            id={field.name}
                            type="multiple"
                            disabled={field.disabled}
                            className="grid auto-rows-fr grid-cols-1 gap-2 @lg:grid-cols-2 @3xl:grid-cols-3"
                            value={Object.entries(field.value || {})
                                .filter(([, prop]) => prop.value)
                                .map(([key]) => key)}
                            onValueChange={(values) => {
                                const currentOptions =
                                    form.getValues("reviewOptions") || {};
                                const currentVersionOptions = safeArray<CodeReviewLabel>(labels).map(
                                    (label) => label.type,
                                );

                                const updatedOptions = { ...currentOptions };

                                currentVersionOptions.forEach((option) => {
                                    const isSelected = values.includes(option);
                                    const existingOption =
                                        updatedOptions[option];

                                    if (existingOption) {
                                        updatedOptions[option] = {
                                            ...existingOption,
                                            value: isSelected,
                                            level: currentLevel,
                                        };
                                    } else {
                                        updatedOptions[option] = {
                                            value: isSelected,
                                            level: currentLevel,
                                        };
                                    }
                                });

                                field.onChange(updatedOptions);
                            }}>
                            {reviewOptionsOptions.map((option) => {
                                const hasSkill = Boolean(
                                    CATEGORY_SKILLS[option.value],
                                );
                                const isEnabled =
                                    field.value?.[option.value]?.value || false;
                                const showSkillButton = hasSkill && isEnabled;
                                return (
                                    <div
                                        key={option.value}
                                        className="relative">
                                        <ToggleGroup.ToggleGroupItem
                                            asChild
                                            value={option.value}>
                                            <Button
                                                size="lg"
                                                variant="helper"
                                                className={`w-full items-start py-5${showSkillButton ? " pr-12" : ""}`}>
                                                <div className="flex w-full flex-row justify-between gap-6">
                                                    <div className="flex min-w-0 flex-col gap-2">
                                                        <div className="flex items-center gap-2">
                                                            <Heading
                                                                variant="h3"
                                                                className="truncate">
                                                                {option.name}
                                                            </Heading>
                                                            <OverrideIndicatorForm
                                                                fieldName={`reviewOptions.${option.value}`}
                                                            />
                                                        </div>

                                                        <p className="text-text-secondary text-xs">
                                                            {option.description}
                                                        </p>
                                                    </div>

                                                    <Checkbox
                                                        decorative
                                                        checked={isEnabled}
                                                    />
                                                </div>
                                            </Button>
                                        </ToggleGroup.ToggleGroupItem>

                                        {showSkillButton && (
                                            <Button
                                                size="icon-sm"
                                                variant="cancel"
                                                type="button"
                                                aria-label={`Configure ${option.name}`}
                                                className="absolute bottom-0 right-3 top-0 my-auto h-fit"
                                                onClick={() =>
                                                    setConfiguringCategory(
                                                        option.value,
                                                    )
                                                }>
                                                <Settings2Icon />
                                            </Button>
                                        )}
                                    </div>
                                );
                            })}
                        </ToggleGroup.Root>
                    </FormControl.Input>
                </FormControl.Root>
            )}
        />

        {configuringCategory && CATEGORY_SKILLS[configuringCategory] && (
            <SkillEditorModal
                skillName={CATEGORY_SKILLS[configuringCategory].skillName}
                title={reviewOptionsOptions.find((o) => o.value === configuringCategory)?.name ?? configuringCategory}
                open={true}
                onOpenChange={(open) => {
                    if (!open) setConfiguringCategory(null);
                }}
            />
        )}
        </>
    );
};
