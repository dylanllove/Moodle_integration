export {
  complete,
  completeWhere,
  completeStream,
  hasApiKey,
  MODEL_FAST,
  MODEL_DRAFT,
  type CompleteOpts,
} from "./client.js";
export {
  aiHealth,
  localStatus,
  spend,
  budgetUsd,
  setBudgetUsd,
  cacheStats,
  clearCache,
  estimateCost,
  record as recordAiUsage,
  type AiHealth,
  type AiFault,
  type AiTier,
  type Provider,
  type Spend,
} from "./gateway.js";
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
