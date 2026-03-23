import { readStdin } from '../stdin';
import { buildContext } from '../context';
import type { HookResponse } from './user-prompt-submit';

export function handleSessionStart(
  input: Record<string, unknown>,
  dbPath?: string,
): HookResponse {
  const project = (input.cwd ?? process.cwd()) as string;

  const context = buildContext(project, undefined, dbPath);

  if (context) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    };
  }

  return { continue: true };
}

if (import.meta.main) {
  try {
    const input = await readStdin();
    const result = handleSessionStart(input ?? { cwd: process.cwd() });
    process.stdout.write(JSON.stringify(result));
  } catch (e) {
    console.error(`wayfarer: session-start failed: ${(e as Error).message}`);
  }
  process.exit(0);
}
