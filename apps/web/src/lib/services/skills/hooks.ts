import { useQuery } from "@tanstack/react-query";

import { getSkillInstructions, getSkillVersions, SKILLS_PATHS } from "./fetch";

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
