export type CodexSdkModule = {
  Codex: new (options?: {
    codexPathOverride?: string;
    baseUrl?: string;
    apiKey?: string;
    config?: Record<string, unknown>;
    env?: Record<string, string>;
  }) => {
    startThread(options?: Record<string, unknown>): {
      id: string | null;
      runStreamed(
        input: string,
        turnOptions?: { signal?: AbortSignal; outputSchema?: unknown }
      ): Promise<{ events: AsyncIterable<unknown> }>;
    };
    resumeThread?(
      id: string,
      options?: Record<string, unknown>
    ): {
      id: string | null;
      runStreamed(
        input: string,
        turnOptions?: { signal?: AbortSignal; outputSchema?: unknown }
      ): Promise<{ events: AsyncIterable<unknown> }>;
    };
  };
};

export async function loadCodexSdk(): Promise<CodexSdkModule> {
  const packageName = "@openai/codex-sdk";

  try {
    return (await import(packageName)) as CodexSdkModule;
  } catch (error) {
    throw new Error(
      `Failed to load ${packageName}. Run pnpm install and ensure Codex authentication is configured. ${formatError(error)}`
    );
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
