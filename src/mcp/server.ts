#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { getMiniActor, type InputSchema } from '../mini-actors.js';
import { handleModelContextProtocol } from '../search.js';
import type { Input } from '../types.js';

export class McpServer {
    private server: Server;
    private toolName: string;

    constructor() {
        const miniActor = getMiniActor();
        const { inputSchema, mcpServerName: serverName } = miniActor;
        this.toolName = inputSchema.title.toLowerCase().replace(/ /g, '-');

        this.server = new Server(
            {
                name: serverName,
                version: '0.1.0',
            },
            {
                capabilities: {
                    tools: {},
                },
            },
        );
        this.setupErrorHandling();
        this.setupToolHandlers(inputSchema);
    }

    private setupErrorHandling(): void {
        this.server.onerror = (error) => {
            console.error('[MCP Error]', error); // eslint-disable-line no-console
        };
        process.on('SIGINT', async () => {
            await this.server.close();
            process.exit(0);
        });
    }

    private setupToolHandlers(inputSchema: InputSchema): void {
        const tools = [
            {
                name: this.toolName,
                description: inputSchema.description,
                inputSchema,
            },
        ];

        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return { tools };
        });
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            if (name === this.toolName) {
                const content = await handleModelContextProtocol(args as unknown as Input);
                return { content: content.map((message) => ({ type: 'text', text: JSON.stringify(message) })) };
            }
            throw new Error(`Unknown tool: ${name}`);
        });
    }

    async connect(transport: Transport): Promise<void> {
        await this.server.connect(transport);
    }
}
