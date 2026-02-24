import { createLogger } from '@kodus/flow';
import { PlatformType } from '@libs/core/domain/enums';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sandbox } from 'e2b';

import { RemoteCommands } from './collectCrossFileContexts.service';

const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const REPO_DIR = '/home/user/repo';

interface CreateSandboxParams {
    cloneUrl: string;
    authToken: string;
    branch: string;
    prNumber: number;
    platform: PlatformType;
}

interface SandboxWithCommands {
    remoteCommands: RemoteCommands;
    cleanup: () => Promise<void>;
}

@Injectable()
export class E2BSandboxService {
    private readonly logger = createLogger(E2BSandboxService.name);

    constructor(private readonly configService: ConfigService) {}

    isAvailable(): boolean {
        return !!this.configService.get<string>('E2B_API_KEY');
    }

    async createSandboxWithRepo(
        params: CreateSandboxParams,
    ): Promise<SandboxWithCommands> {
        const { cloneUrl, authToken, branch, prNumber, platform } = params;
        const apiKey = this.configService.get<string>('E2B_API_KEY');

        if (!apiKey) {
            throw new Error('E2B_API_KEY is not configured');
        }

        const sandbox = await Sandbox.create({
            timeoutMs: SANDBOX_TIMEOUT_MS,
            apiKey,
        });

        try {
            // Install git + ripgrep (must run as root for apt)
            await sandbox.commands.run(
                'apt-get update -qq && apt-get install -y -qq git ripgrep > /dev/null 2>&1',
                { timeoutMs: 120_000, user: 'root' },
            );

            // Shallow-fetch only the PR ref (minimal network transfer)
            const refspec = this.getPrRefspec(platform, prNumber);
            const authHeader = this.buildAuthHeader(platform, authToken);

            await sandbox.commands.run(
                [
                    `git init ${REPO_DIR}`,
                    `cd ${REPO_DIR}`,
                    // Fetch using token from env var via git credential header (never touches disk/process args)
                    `git -c http.extraHeader="$GIT_AUTH_HEADER" fetch --depth=1 ${cloneUrl} ${refspec}:pr-head`,
                    `git checkout pr-head`,
                    // Set a dummy remote for any tools that expect "origin" to exist
                    `git remote add origin ${cloneUrl}`,
                    // Block any push from the sandbox
                    `git remote set-url --push origin no-push-allowed`,
                ].join(' && '),
                {
                    timeoutMs: 120_000,
                    envs: { GIT_AUTH_HEADER: authHeader },
                },
            );

            const remoteCommands = this.buildRemoteCommands(sandbox);

            const cleanup = async () => {
                try {
                    await sandbox.kill();
                } catch (error) {
                    this.logger.warn({
                        message: `Failed to kill E2B sandbox for PR#${prNumber}`,
                        context: E2BSandboxService.name,
                        error,
                    });
                }
            };

            return { remoteCommands, cleanup };
        } catch (error) {
            // If setup fails, kill the sandbox before re-throwing
            try {
                await sandbox.kill();
            } catch {
                // Ignore cleanup errors
            }
            throw error;
        }
    }

    private buildAuthHeader(
        platform: PlatformType,
        token: string,
    ): string {
        // Git http.extraHeader sends an Authorization header — token never embedded in URLs
        switch (platform) {
            case PlatformType.GITHUB:
            case PlatformType.BITBUCKET:
                return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
            case PlatformType.GITLAB:
            case PlatformType.AZURE_REPOS:
                return `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
            default:
                return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
        }
    }

    private getPrRefspec(
        platform: PlatformType,
        prNumber: number,
    ): string {
        switch (platform) {
            case PlatformType.GITHUB:
                return `refs/pull/${prNumber}/head`;
            case PlatformType.GITLAB:
                return `refs/merge-requests/${prNumber}/head`;
            case PlatformType.BITBUCKET:
                return `refs/pull-requests/${prNumber}/from`;
            case PlatformType.AZURE_REPOS:
                return `refs/pull/${prNumber}/merge`;
            default:
                return `refs/pull/${prNumber}/head`;
        }
    }

    private buildRemoteCommands(sandbox: Sandbox): RemoteCommands {
        return {
            grep: async (
                pattern: string,
                path: string,
                glob?: string,
            ): Promise<string> => {
                const fullPath = this.resolvePath(path);
                const escapedPath = fullPath.replace(/'/g, "'\\''");
                const globArg = glob
                    ? ` --glob '${glob.replace(/'/g, "'\\''")}'`
                    : '';
                // Use single quotes to prevent bash from interpreting
                // regex escape sequences (e.g. \b as backspace).
                const escapedPattern = pattern.replace(/'/g, "'\\''");
                const result = await sandbox.commands.run(
                    `rg --no-heading -n '${escapedPattern}' '${escapedPath}'${globArg}`,
                    { timeoutMs: 30_000 },
                );
                return result.stdout;
            },

            read: async (
                path: string,
                start: number,
                end: number,
            ): Promise<string> => {
                const fullPath = this.resolvePath(path);
                const escapedPath = fullPath.replace(/'/g, "'\\''");
                const result = await sandbox.commands.run(
                    `sed -n '${start},${end}p' '${escapedPath}'`,
                    { timeoutMs: 10_000 },
                );
                return result.stdout;
            },

            listDir: async (
                path: string,
                maxDepth: number,
            ): Promise<string> => {
                const fullPath = this.resolvePath(path);
                const escapedPath = fullPath.replace(/'/g, "'\\''");
                const result = await sandbox.commands.run(
                    `find '${escapedPath}' -maxdepth ${maxDepth} -type f`,
                    { timeoutMs: 30_000 },
                );
                return result.stdout;
            },
        };
    }

    private resolvePath(path: string): string {
        // If the path is already absolute, use it as-is
        if (path.startsWith('/')) {
            return path;
        }
        // Resolve relative paths against the repo directory
        return `${REPO_DIR}/${path}`;
    }
}
