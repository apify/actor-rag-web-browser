#!/usr/bin/env node

/**
 * Model Context Protocol (MCP) server for RAG Web Browser Actor
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import inputSchema from '../../actors/apify_rag-web-browser/.actor/input_schema.json' with { type: 'json' };
import { handleModelContextProtocol } from '../search.js';
import type { Input } from '../types.js';

const TOOL_SEARCH = inputSchema.title.toLowerCase().replace(/ /g, '-');

const TOOLS = [
    {
        name: TOOL_SEARCH,
        description: inputSchema.description,
        inputSchema,
    },
];

/**
 * Create an MCP server with a tool to call RAG Web Browser Actor
 */
export class RagWebBrowserServer {
    private server: Server;

    constructor() {
        this.server = new Server(
            {
                name: 'mcp-server-rag-web-browser',
                version: '0.1.0',
            },
            {
                capabilities: {
                    tools: {},
                },
            },
        );
        this.setupErrorHandling();
        this.setupToolHandlers();
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

    private setupToolHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: TOOLS,
            };
        });
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            switch (name) {
                case TOOL_SEARCH: {
                    const content = await handleModelContextProtocol(args as unknown as Input);
                    return { content: content.map((message) => ({ type: 'text', text: JSON.stringify(message) })) };
                }
                default: {
                    throw new Error(`Unknown tool: ${name}`);
                }
            }
        });
    }

    async connect(transport: Transport): Promise<void> {
        await this.server.connect(transport);
    }
}
