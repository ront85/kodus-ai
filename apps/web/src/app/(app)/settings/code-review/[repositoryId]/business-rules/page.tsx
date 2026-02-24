"use client";

import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import { Textarea } from "@components/ui/textarea";
import { toast } from "@components/ui/toaster/use-toast";
import { getMCPPlugins } from "@services/mcp-manager/fetch";
import { MCP_CONNECTION_STATUS } from "@services/mcp-manager/types";
import {
    useGetSkillInstructions,
    useGetSkillVersions,
} from "@services/skills/hooks";
import {
    restoreSkillVersion,
    saveSkillOverride,
    SKILLS_PATHS,
} from "@services/skills/fetch";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, ClockIcon, RotateCcwIcon, SaveIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { CodeReviewPagesBreadcrumb } from "../../_components/breadcrumb";

const SKILL_NAME = "business-rules-validation";

export default function BusinessRulesPage() {
    const { teamId } = useSelectedTeamId();
    const queryClient = useQueryClient();

    const { data: instructionsRes, isLoading: instructionsLoading } =
        useGetSkillInstructions(SKILL_NAME, teamId);
    const { data: versionsRes } = useGetSkillVersions(SKILL_NAME, teamId);

    const { data: plugins = [] } = useQuery({
        queryKey: ["mcp-plugins"],
        queryFn: getMCPPlugins,
    });

    const instructions = instructionsRes?.instructions ?? "";
    const source = instructionsRes?.source ?? "filesystem";
    const versions = versionsRes ?? [];

    const [content, setContent] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [isRestoring, setIsRestoring] = useState<number | null>(null);

    // Current value being displayed — local edits take priority
    const displayContent = content ?? instructions;
    const isDirty = content !== null && content !== instructions;

    // Task management plugins: any non-default plugin that is connected and ACTIVE
    const hasTaskPlugin = plugins.some(
        (p) =>
            !p.isDefault &&
            p.isConnected &&
            p.connectionStatus === MCP_CONNECTION_STATUS.ACTIVE,
    );

    const invalidateQueries = async () => {
        await queryClient.invalidateQueries({
            queryKey: [SKILLS_PATHS.GET_INSTRUCTIONS(SKILL_NAME), { teamId }],
        });
        await queryClient.invalidateQueries({
            queryKey: [SKILLS_PATHS.GET_VERSIONS(SKILL_NAME), { teamId }],
        });
    };

    const handleSave = async () => {
        if (!isDirty || !content) return;
        setIsSaving(true);
        try {
            await saveSkillOverride(SKILL_NAME, teamId, content);
            await invalidateQueries();
            setContent(null);
            toast({ description: "Instructions saved", variant: "success" });
        } catch {
            toast({
                title: "Error",
                description: "Failed to save instructions. Please try again.",
                variant: "danger",
            });
        } finally {
            setIsSaving(false);
        }
    };

    const handleReset = async () => {
        setContent(null);
        await invalidateQueries();
    };

    const handleRestore = async (version: number) => {
        setIsRestoring(version);
        try {
            await restoreSkillVersion(SKILL_NAME, teamId, version);
            await invalidateQueries();
            setContent(null);
            toast({
                description: `Restored to version ${version}`,
                variant: "success",
            });
        } catch {
            toast({
                title: "Error",
                description: "Failed to restore version. Please try again.",
                variant: "danger",
            });
        } finally {
            setIsRestoring(null);
        }
    };

    return (
        <Page.Root>
            <Page.Header>
                <CodeReviewPagesBreadcrumb pageName="Business Rules" />
            </Page.Header>

            <Page.Header>
                <Page.Title>Business Rules Validation</Page.Title>

                <Page.HeaderActions>
                    <Button
                        size="md"
                        variant="primary"
                        leftIcon={<SaveIcon />}
                        onClick={handleSave}
                        disabled={!isDirty}
                        loading={isSaving}>
                        Save settings
                    </Button>
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content className="space-y-6">
                {/* MCP requirement warning */}
                {!hasTaskPlugin && (
                    <Alert variant="warning">
                        <AlertTriangleIcon />
                        <AlertTitle>Task management integration required</AlertTitle>
                        <AlertDescription className="mt-1 flex flex-col gap-3">
                            <p>
                                Business rules validation works by comparing PR
                                changes against your task requirements. Connect a
                                task management plugin (Jira, Linear, Notion,
                                ClickUp, etc.) so Kody can fetch the linked
                                ticket context automatically.
                            </p>
                            <Link href="/settings/plugins" className="w-fit">
                                <Button size="sm" variant="outline">
                                    Go to Plugins
                                </Button>
                            </Link>
                        </AlertDescription>
                    </Alert>
                )}

                {/* Instructions editor */}
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between gap-4 px-6 pt-5 pb-4">
                        <Heading variant="h3">Instructions</Heading>

                        <div className="flex items-center gap-2">
                            {source === "db" && (
                                <>
                                    <Badge variant="secondary">Custom</Badge>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        leftIcon={<RotateCcwIcon />}
                                        onClick={handleReset}>
                                        Reset to default
                                    </Button>
                                </>
                            )}
                        </div>
                    </CardHeader>

                    <CardContent className="px-6 pb-6">
                        <Textarea
                            value={instructionsLoading ? "" : displayContent}
                            loading={instructionsLoading}
                            onChange={(e) => setContent(e.target.value)}
                            rows={24}
                            className="font-mono text-sm"
                            placeholder="Loading instructions..."
                        />
                    </CardContent>
                </Card>

                {/* Version history */}
                {versions.length > 0 && (
                    <Card>
                        <CardHeader className="flex flex-row items-center gap-2 px-6 pt-5 pb-4">
                            <ClockIcon className="size-4 text-text-secondary" />
                            <Heading variant="h3">Version History</Heading>
                        </CardHeader>

                        <CardContent className="px-6 pb-6">
                            <ul className="space-y-2">
                                {versions.map((v) => (
                                    <li
                                        key={v.version}
                                        className="flex items-center justify-between rounded-lg border border-card-lv3 px-4 py-3">
                                        <div className="flex flex-col gap-0.5">
                                            <span className="text-sm font-medium">
                                                Version {v.version}
                                            </span>
                                            {v.updatedAt && (
                                                <span className="text-text-secondary text-xs">
                                                    {new Date(
                                                        v.updatedAt,
                                                    ).toLocaleString()}
                                                </span>
                                            )}
                                        </div>

                                        <Button
                                            size="sm"
                                            variant="outline"
                                            leftIcon={<RotateCcwIcon />}
                                            loading={
                                                isRestoring === v.version
                                            }
                                            onClick={() =>
                                                handleRestore(v.version)
                                            }>
                                            Restore
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        </CardContent>
                    </Card>
                )}
            </Page.Content>
        </Page.Root>
    );
}
