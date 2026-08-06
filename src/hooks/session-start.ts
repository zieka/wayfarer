import { readStdin } from '../stdin';
import { primerForSession } from '../retrieve';
import type { HookResponse } from './user-prompt-submit';

export function handleSessionStart(
  input: Record<string, unknown>,
  dbPath?: string,
): HookResponse {
  const project = (input.cwd ?? process.cwd()) as string;

  try {
    const context = primerForSession(project, dbPath);

    if (context) {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: context,
        },
      };
    }
  } catch (e) {
    console.error(`wayfarer: session-start failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { continue: true };
}

if (import.meta.main) {
  try {
    const input = await readStdin();
    const result = handleSessionStart(input ?? { cwd: process.cwd() });
    process.stdout.write(JSON.stringify(result));
  } catch (e) {
    console.error(`wayfarer: session-start failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(0);
}
