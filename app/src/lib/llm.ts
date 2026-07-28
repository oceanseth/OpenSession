/**
 * Optional in-browser LLM (Chrome's built-in Prompt API / Gemini Nano) for
 * suggesting discussion-thread titles from a session turn. Feature-detected;
 * every failure path returns null and the UI falls back to a plain input.
 */

interface LanguageModelLike {
  availability?: () => Promise<string>;
  create: (opts?: unknown) => Promise<{
    prompt: (text: string) => Promise<string>;
    destroy?: () => void;
  }>;
}

function getLanguageModel(): LanguageModelLike | null {
  const w = window as unknown as {
    LanguageModel?: LanguageModelLike;
    ai?: { languageModel?: LanguageModelLike };
  };
  return w.LanguageModel ?? w.ai?.languageModel ?? null;
}

export async function hasBrowserLlm(): Promise<boolean> {
  const lm = getLanguageModel();
  if (!lm?.create) return false;
  try {
    if (lm.availability) return (await lm.availability()) === 'available';
    return true;
  } catch {
    return false;
  }
}

export async function suggestThreadTitle(turnText: string): Promise<string | null> {
  const lm = getLanguageModel();
  if (!lm?.create) return null;
  try {
    if (lm.availability && (await lm.availability()) !== 'available') return null;
    const session = await lm.create();
    const out = await session.prompt(
      'Write one concise discussion-thread title (at most 10 words, plain text, no quotes or trailing punctuation) ' +
        'for a forum thread about this excerpt from a human–AI coding session:\n\n' +
        turnText.slice(0, 1500),
    );
    session.destroy?.();
    const title = String(out).trim().split('\n')[0].replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 140);
    return title || null;
  } catch {
    return null;
  }
}
