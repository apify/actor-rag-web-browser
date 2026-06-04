#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import ragWebBrowserInputSchema from '../../actors/apify_rag-web-browser/.actor/input_schema.json' with { type: 'json' };
import urlToMarkdownInputSchema from '../../actors/apify_url-to-markdown/.actor/input_schema.json' with { type: 'json' };
import { MINIACTORS } from '../input.js';
import { handleModelContextProtocol } from '../search.js';
import type { Input } from '../types.js';

type InputSchema = typeof ragWebBrowserInputSchema | typeof urlToMarkdownInputSchema;

const TOOL_CONFIGS: Record<string, { inputSchema: InputSchema; serverName: string }> = {
    [MINIACTORS.RAG_WEB_BROWSER]: {
        inputSchema: ragWebBrowserInputSchema,
        serverName: 'mcp-server-rag-web-browser',
    },
    [MINIACTORS.URL_TO_MARKDOWN]: {
        inputSchema: urlToMarkdownInputSchema,
        serverName: 'mcp-server-url-to-markdown',
    },
};

export class McpServer {
    private server: Server;
    private toolName: string;

    constructor(selectedMiniActor: string) {
        const config = TOOL_CONFIGS[selectedMiniActor] ?? TOOL_CONFIGS[MINIACTORS.RAG_WEB_BROWSER];
        const { inputSchema, serverName } = config;
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
