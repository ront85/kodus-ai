"use client";

import { useMemo, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { Link } from "@components/ui/link";
import { Textarea } from "@components/ui/textarea";
import { toast } from "@components/ui/toaster/use-toast";
import { getMCPPlugins } from "@services/mcp-manager/fetch";
import { MCP_CONNECTION_STATUS } from "@services/mcp-manager/types";
import {
    restoreSkillVersion,
    saveSkillOverride,
    SKILLS_PATHS,
} from "@services/skills/fetch";
import {
    useGetSkillInstructions,
    useGetSkillMeta,
    useGetSkillVersions,
} from "@services/skills/hooks";
import type {
    SkillEditableContent,
    SkillRequiredMcp,
} from "@services/skills/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
    AlertTriangleIcon,
    ClockIcon,
    RotateCcwIcon,
    SaveIcon,
} from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

interface SkillEditorModalProps {
    skillName: string;
    title: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function SkillEditorModal({
    skillName,
    title,
    open,
    onOpenChange,
}: SkillEditorModalProps) {
    const { teamId } = useSelectedTeamId();
    const queryClient = useQueryClient();

    const { data: meta } = useGetSkillMeta(skillName);
    const { data: instructionsRes, isLoading: instructionsLoading } =
        useGetSkillInstructions(skillName, teamId);
    const { data: versions = [] } = useGetSkillVersions(skillName, teamId);

    const { data: plugins = [] } = useQuery({
        queryKey: ["mcp-plugins"],
        queryFn: getMCPPlugins,
    });

    const instructions = instructionsRes?.instructions ?? "";
    const source = instructionsRes?.source ?? "filesystem";
    const initialEditableJson = useMemo(
        () => JSON.stringify(instructionsRes?.editable ?? {}, null, 2),
        [instructionsRes?.editable],
    );

    const [editableJson, setEditableJson] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [isRestoring, setIsRestoring] = useState<number | null>(null);

    const displayEditableJson = editableJson ?? initialEditableJson;
    const isDirty =
        editableJson !== null && editableJson !== initialEditableJson;

    // For each required MCP category, check if at least one connected plugin satisfies it.
    // A plugin satisfies a category when it is non-default, connected, and ACTIVE.
    // (Category matching is generic — any connected non-default plugin counts for now;
    //  future: match by plugin category tag when the MCP manager exposes it.)
    const connectedNonDefaultPlugins = plugins.filter(
        (p) =>
            !p.isDefault &&
            p.isConnected &&
            p.connectionStatus === MCP_CONNECTION_STATUS.ACTIVE,
    );

    const missingMcps: SkillRequiredMcp[] = (meta?.requiredMcps ?? []).filter(
        (_req) => connectedNonDefaultPlugins.length === 0,
        // TODO: when MCP manager exposes category tags, filter by _req.category
    );

    const invalidateQueries = async () => {
        await queryClient.invalidateQueries({
            queryKey: [SKILLS_PATHS.GET_INSTRUCTIONS(skillName), { teamId }],
        });
        await queryClient.invalidateQueries({
            queryKey: [SKILLS_PATHS.GET_VERSIONS(skillName), { teamId }],
        });
    };

    const handleSave = async () => {
        if (!isDirty || !editableJson) return;
        setIsSaving(true);
        try {
            const parsed = JSON.parse(editableJson) as SkillEditableContent;
            await saveSkillOverride(skillName, teamId, parsed);
            await invalidateQueries();
            setEditableJson(null);
            toast({
                description: "Editable template saved",
                variant: "success",
            });
        } catch (error) {
            const isParseError =
                error instanceof SyntaxError ||
                (error instanceof Error &&
                    error.message.includes("JSON"));

            if (isParseError) {
                toast({
                    title: "Invalid JSON",
                    description:
                        "Fix the JSON syntax before saving the editable template.",
                    variant: "danger",
                });
                return;
            }

            toast({
                title: "Error",
                description: "Failed to save editable template. Please try again.",
                variant: "danger",
            });
        } finally {
            setIsSaving(false);
        }
    };

    const handleReset = async () => {
        const defaultEditable = instructionsRes?.defaultEditable;
        if (!defaultEditable) {
            setEditableJson(null);
            await invalidateQueries();
            return;
        }

        setIsSaving(true);
        try {
            await saveSkillOverride(skillName, teamId, defaultEditable);
            await invalidateQueries();
            setEditableJson(null);
            toast({
                description: "Reset to default template",
                variant: "success",
            });
        } catch {
            toast({
                title: "Error",
                description: "Failed to reset template. Please try again.",
                variant: "danger",
            });
        } finally {
            setIsSaving(false);
        }
    };

    const handleRestore = async (version: number) => {
        setIsRestoring(version);
        try {
            await restoreSkillVersion(skillName, teamId, version);
            await invalidateQueries();
            setEditableJson(null);
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
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{title} — Instructions</DialogTitle>
                    <DialogDescription className="sr-only">
                        Edit and manage the instructions for this skill.
                    </DialogDescription>
                </DialogHeader>

                {/* Missing MCP warnings — one per required category */}
                {missingMcps.map((req) => (
                    <div
                        key={req.category}
                        className="flex items-start gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm">
                        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-yellow-400" />
                        <div className="flex flex-col gap-1">
                            <span className="font-medium text-yellow-300">
                                {req.label} integration required
                            </span>
                            <span className="text-text-secondary">
                                {req.examples
                                    ? `Connect a plugin (${req.examples}) so Kody can fetch the context it needs.`
                                    : `Connect a ${req.label} plugin so Kody can fetch the context it needs.`}{" "}
                                <Link
                                    href="/settings/plugins"
                                    className="text-yellow-400 underline">
                                    Go to Plugins
                                </Link>
                            </span>
                        </div>
                    </div>
                ))}

                {/* Editable JSON editor */}
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                        <label
                            htmlFor="skill-instructions"
                            className="text-sm font-medium">
                            Editable Template (JSON)
                        </label>
                        <div className="flex items-center gap-2">
                            {source === "db" && (
                                <>
                                    <Badge variant="secondary">Custom</Badge>
                                    <Button
                                        size="sm"
                                        variant="tertiary"
                                        leftIcon={<RotateCcwIcon />}
                                        loading={isSaving}
                                        onClick={handleReset}>
                                        Reset to default
                                    </Button>
                                </>
                            )}
                        </div>
                    </div>

                    <Textarea
                        id="skill-instructions"
                        value={instructionsLoading ? "" : displayEditableJson}
                        loading={instructionsLoading}
                        onChange={(e) => setEditableJson(e.target.value)}
                        rows={16}
                        className="font-mono text-sm"
                        placeholder="Loading editable template..."
                    />
                    <p className="text-text-secondary text-xs">
                        Immutable platform instructions (tools, output contract,
                        and safety rules) are not editable. Only this JSON block
                        is persisted per team.
                    </p>
                </div>

                {/* Compiled instructions preview */}
                <div className="flex flex-col gap-2">
                    <label
                        htmlFor="compiled-instructions"
                        className="text-sm font-medium">
                        Compiled Instructions (read-only)
                    </label>
                    <Textarea
                        id="compiled-instructions"
                        value={instructionsLoading ? "" : instructions}
                        loading={instructionsLoading}
                        readOnly
                        rows={10}
                        className="font-mono text-xs"
                        placeholder="Loading instructions..."
                    />
                </div>

                {/* Version history (compact) */}
                {versions.length > 0 && (
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                            <ClockIcon className="size-3.5 text-text-secondary" />
                            <span className="text-sm font-medium">
                                Version History
                            </span>
                        </div>
                        <ul className="max-h-40 space-y-1.5 overflow-y-auto">
                            {versions.map((v) => (
                                <li
                                    key={v.version}
                                    className="flex items-center justify-between rounded-lg border border-card-lv3 px-3 py-2">
                                    <div className="flex flex-col gap-0.5">
                                        <span className="text-sm font-medium">
                                            Version {v.version}
                                        </span>
                                        {v.updatedAt && (
                                            <span
                                                className="text-text-secondary text-xs"
                                                suppressHydrationWarning>
                                                {new Date(
                                                    v.updatedAt,
                                                ).toLocaleString()}
                                            </span>
                                        )}
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="tertiary"
                                        leftIcon={<RotateCcwIcon />}
                                        loading={isRestoring === v.version}
                                        onClick={() =>
                                            handleRestore(v.version)
                                        }>
                                        Restore
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {/* Footer actions */}
                <div className="flex justify-end gap-2 pt-2">
                    <Button
                        size="md"
                        variant="cancel"
                        onClick={() => onOpenChange(false)}>
                        Close
                    </Button>
                    <Button
                        size="md"
                        variant="primary"
                        leftIcon={<SaveIcon />}
                        onClick={handleSave}
                        disabled={!isDirty}
                        loading={isSaving}>
                        Save
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
