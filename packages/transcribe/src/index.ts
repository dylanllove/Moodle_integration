export {
  extractAudio,
  extractAudioMp3,
  probeDuration,
  speechSpans,
  writeSpeechOnly,
  toOriginalTime,
  type SpeechMap,
} from "./ffmpeg.js";
export {
  transcribeFile,
  transcribeProvider,
  canTranscribe,
  TranscriptionDeferred,
  type TranscriptResult,
  type TranscriptProvider,
} from "./openai-transcribe.js";
export { resolveMediaSource, type MediaSource } from "./download.js";

export {
  localTranscriber,
  transcribeLocally,
  ensureWhisperModel,
  whisperInstallProgress,
  whisperCppBinary,
  WHISPER_MODEL_FILE,
  type LocalTranscriber,
  type InstallProgress,
} from "./local-transcribe.js";
