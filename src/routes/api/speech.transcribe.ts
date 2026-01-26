import type { Route } from './+types/speech.transcribe';
import { getEnv } from '@/lib/cloudflare.server';
import { requireAuthContext } from '@/lib/auth.server';

// POST /api/speech/transcribe
// Body: { audio: string (base64 encoded audio) }
// Returns: { text: string }
export async function action({ request, context }: Route.ActionArgs) {
  // Require authentication
  await requireAuthContext(request, context);

  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const body = await request.json();
    const { audio } = body as { audio?: string };

    if (!audio) {
      return Response.json({ error: 'Missing audio data' }, { status: 400 });
    }

    // Validate base64 and check size
    const audioSizeBytes = Math.ceil((audio.length * 3) / 4);
    const audioSizeMB = audioSizeBytes / (1024 * 1024);
    console.log(`[speech/transcribe] Audio size: ${audioSizeMB.toFixed(2)} MB`);

    if (audioSizeMB > 25) {
      return Response.json(
        { error: 'Audio file too large. Maximum size is 25MB.' },
        { status: 400 }
      );
    }

    const env = getEnv(context);

    // Call Whisper model for transcription
    // See: https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/
    const ai = env.AI as {
      run: (
        model: string,
        options: {
          audio: string;
          task?: 'transcribe' | 'translate';
          language?: string;
          vad_filter?: string;
        }
      ) => Promise<{ text?: string; vtt?: string; word_count?: number }>;
    };

    // Try whisper-large-v3-turbo first, fall back to whisper if it fails
    let result: { text?: string; vtt?: string; word_count?: number };
    try {
      result = await ai.run('@cf/openai/whisper-large-v3-turbo', {
        audio,
      });
    } catch (turboError) {
      console.warn(
        '[speech/transcribe] whisper-large-v3-turbo failed, trying whisper:',
        turboError
      );
      // Fallback to the standard whisper model
      result = await ai.run('@cf/openai/whisper', {
        audio,
      });
    }

    const text = result?.text?.trim() || '';

    return Response.json({ text });
  } catch (e) {
    console.error('[speech/transcribe] Error:', e);
    const errorMessage = e instanceof Error ? e.message : 'Unknown error';
    return Response.json(
      { error: `Failed to transcribe audio: ${errorMessage}` },
      { status: 500 }
    );
  }
}
