import { authorizedFetch } from "@services/fetch";
import { pathToApiUrl } from "src/core/utils/helpers";

import type { SkillInstructions, SkillMeta, SkillVersion } from "./types";

export const SKILLS_PATHS = {
    GET_META: (skillName: string) =>
        pathToApiUrl(`/skills/${skillName}/meta`),
    GET_INSTRUCTIONS: (skillName: string) =>
        pathToApiUrl(`/skills/${skillName}/instructions`),
    GET_VERSIONS: (skillName: string) =>
        pathToApiUrl(`/skills/${skillName}/versions`),
    SAVE_OVERRIDE: (skillName: string) =>
        pathToApiUrl(`/skills/${skillName}/override`),
    RESTORE_VERSION: (skillName: string) =>
        pathToApiUrl(`/skills/${skillName}/restore`),
};

export const getSkillMeta = (skillName: string) =>
    authorizedFetch<SkillMeta>(SKILLS_PATHS.GET_META(skillName));

export const getSkillInstructions = (skillName: string, teamId: string) =>
    authorizedFetch<SkillInstructions>(
        SKILLS_PATHS.GET_INSTRUCTIONS(skillName),
        { params: { teamId } },
    );

export const getSkillVersions = (skillName: string, teamId: string) =>
    authorizedFetch<SkillVersion[]>(
        SKILLS_PATHS.GET_VERSIONS(skillName),
        { params: { teamId } },
    );

export const saveSkillOverride = (
    skillName: string,
    teamId: string,
    content: string,
) =>
    authorizedFetch<{ version: number }>(
        SKILLS_PATHS.SAVE_OVERRIDE(skillName),
        {
            method: "POST",
            body: JSON.stringify({ teamId, content }),
        },
    );

export const restoreSkillVersion = (
    skillName: string,
    teamId: string,
    version: number,
) =>
    authorizedFetch<{}>(SKILLS_PATHS.RESTORE_VERSION(skillName), {
        method: "POST",
        body: JSON.stringify({ teamId, version }),
    });
