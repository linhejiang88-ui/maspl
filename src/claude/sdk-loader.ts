export type ClaudeSdkModule = {
  query: (args: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<unknown>;
  tool: (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
    extras?: Record<string, unknown>
  ) => unknown;
  createSdkMcpServer: (args: {
    name: string;
    version: string;
    tools: unknown[];
  }) => unknown;
};

export async function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  const packageName = "@anthropic-ai/claude-agent-sdk";

  try {
    return (await import(packageName)) as ClaudeSdkModule;
  } catch (error) {
    throw new Error(
      `Failed to load ${packageName}. Run pnpm install and ensure Claude Code authentication is configured. ${formatError(error)}`
    );
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
