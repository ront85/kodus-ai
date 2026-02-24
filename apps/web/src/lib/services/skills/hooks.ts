import { useQuery } from "@tanstack/react-query";

import {
    getSkillInstructions,
    getSkillMeta,
    getSkillVersions,
    SKILLS_PATHS,
} from "./fetch";

export const useGetSkillMeta = (skillName: string) =>
    useQuery({
        queryKey: [SKILLS_PATHS.GET_META(skillName)],
        queryFn: () => getSkillMeta(skillName),
        staleTime: 5 * 60 * 1000, // meta rarely changes — cache for 5 min
    });

export const useGetSkillInstructions = (skillName: string, teamId: string) =>
    useQuery({
        queryKey: [SKILLS_PATHS.GET_INSTRUCTIONS(skillName), { teamId }],
        queryFn: () => getSkillInstructions(skillName, teamId),
        enabled: !!teamId,
    });

export const useGetSkillVersions = (skillName: string, teamId: string) =>
    useQuery({
        queryKey: [SKILLS_PATHS.GET_VERSIONS(skillName), { teamId }],
        queryFn: () => getSkillVersions(skillName, teamId),
        enabled: !!teamId,
    });
