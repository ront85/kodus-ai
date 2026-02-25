import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMCPAdapter, MCPRegistry } from '../../../src/adapters/mcp/index.js';

describe('MCP Adapter connection state', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should reject connect when no MCP servers are configured', async () => {
        const adapter = createMCPAdapter({
            servers: [],
        });

        await expect(adapter.connect()).rejects.toThrow(
            'No MCP servers configured',
        );
        await expect(adapter.getTools()).rejects.toThrow(
            'MCP adapter not connected. Call connect() first.',
        );
    });

    it('should reject connect when all MCP server registrations fail', async () => {
        vi.spyOn(MCPRegistry.prototype, 'register').mockRejectedValue(
            new Error('server offline'),
        );

        const adapter = createMCPAdapter({
            servers: [
                {
                    name: 'kodusmcp',
                    type: 'http',
                    url: 'http://localhost:9999',
                },
            ],
        });

        await expect(adapter.connect()).rejects.toThrow(
            'Failed to connect to any MCP server',
        );
        await expect(adapter.getTools()).rejects.toThrow(
            'MCP adapter not connected. Call connect() first.',
        );
    });
});
