export const AUDIO_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

export interface AudioTranscriptionAiBinding {
  run(
    model: string,
    input: { audio: string; task?: "transcribe" | "translate"; language?: string },
  ): Promise<{ text?: string; vtt?: string; word_count?: number }>;
}

export interface AudioTranscriptionResult {
  text: string;
}

export function stripAudioDataUrlPrefix(value: string): string {
  return value.replace(/^data:audio\/[^;,]+(?:;[^,]+)*,/, "");
}

export function estimateBase64Bytes(base64: string): number {
  const normalized = stripAudioDataUrlPrefix(base64).replace(/\s/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.ceil((normalized.length * 3) / 4) - padding);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function transcribeAudioBase64(
  ai: AudioTranscriptionAiBinding,
  audioBase64: string,
): Promise<AudioTranscriptionResult> {
  const audio = stripAudioDataUrlPrefix(audioBase64).replace(/\s/g, "");
  if (!audio) {
    throw new Error("Audio data is required");
  }
  if (estimateBase64Bytes(audio) > AUDIO_TRANSCRIPTION_MAX_BYTES) {
    throw new Error("Audio file too large. Maximum size is 25MB.");
  }

  let result: { text?: string; vtt?: string; word_count?: number };
  try {
    result = await ai.run("@cf/openai/whisper-large-v3-turbo", { audio });
  } catch (turboError) {
    console.warn(
      "[audio-transcription] whisper-large-v3-turbo failed, trying whisper:",
      turboError,
    );
    result = await ai.run("@cf/openai/whisper", { audio });
  }

  return { text: result?.text?.trim() || "" };
}

export async function transcribeAudioBytes(
  ai: AudioTranscriptionAiBinding,
  audio: ArrayBuffer,
): Promise<AudioTranscriptionResult> {
  if (audio.byteLength > AUDIO_TRANSCRIPTION_MAX_BYTES) {
    throw new Error("Audio file too large. Maximum size is 25MB.");
  }
  return transcribeAudioBase64(ai, arrayBufferToBase64(audio));
}
