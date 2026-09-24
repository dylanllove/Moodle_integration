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
  estimateAudioCost,
  remainingBudgetUsd,
  canComplete,
  record as recordAiUsage,
  type AiHealth,
  type AiFault,
  type AiTier,
  type Provider,
  type Spend,
} from "./gateway.js";
export {
  flashcards,
  generateDeck,
  cheatSheet,
  cleanTranscript,
  type Flashcard,
  type DeckOpts,
} from "./study.js";
export {
  analyseLecture,
  renderNotesMarkdown,
  clock,
  ANALYSIS_VERSION,
  type LectureAnalysis,
  type AnalysisResult,
  type Anchor,
  type ConceptKind,
} from "./analyse.js";
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
