export {
  complete,
  completeStream,
  hasApiKey,
  aiHealth,
  MODEL_FAST,
  MODEL_DRAFT,
  type AiHealth,
  type AiFault,
} from "./client.js";
export {
  summariseLecture,
  transcriptToNotes,
  explain,
  flashcards,
  generateDeck,
  cheatSheet,
  cleanTranscript,
  lectureNotes,
  type Flashcard,
  type DeckOpts,
} from "./study.js";
export {
  indexAll,
  retrieve,
  type RetrievedChunk,
  type ChunkSource,
} from "./retrieval.js";
export {
  outlineAssignment,
  draftSection,
  feedbackOnDraft,
  type AssignmentContext,
} from "./assignment.js";
