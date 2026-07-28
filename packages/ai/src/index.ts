export { complete, hasApiKey, MODEL_FAST, MODEL_DRAFT } from "./client.js";
export {
  summariseLecture,
  transcriptToNotes,
  explain,
  flashcards,
  cheatSheet,
  cleanTranscript,
  lectureNotes,
  type Flashcard,
} from "./study.js";
export {
  indexAll,
  retrieve,
  type RetrievedChunk,
} from "./retrieval.js";
export {
  outlineAssignment,
  draftSection,
  feedbackOnDraft,
  type AssignmentContext,
} from "./assignment.js";
