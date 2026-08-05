export { login, sync } from "./connector.js";
export type { LoginResult, SyncResult } from "./connector.js";
export { syncIcal } from "./ical.js";
export { syncTimetable } from "./timetable.js";
export {
  moodleApiConfigured,
  syncMoodleApi,
  getCourseForumPosts,
  getCourseSlideFiles,
  courseNumericId,
  moodleWs,
  withToken,
  type ForumPost,
  type SlideFile,
} from "./moodle-api.js";
export {
  syncMaterials,
  materialsRoot,
  weekFromText,
  type MaterialsResult,
  type MaterialKind,
  type TextExtractor,
} from "./materials.js";
export { syncGrades, type GradesResult } from "./grades.js";
export { syncPersonal, type PersonalResult } from "./personal.js";
export { openContext, profileDir } from "./session.js";
export type { ScrapeCounts } from "./moodle.js";
export {
  acquireEchoContext,
  persistEchoSession,
  clearEchoSession,
  echoHasSession,
  echoConnected,
  echoVerify,
  loginEcho360,
  listLessons,
  fetchTranscript,
  fetchAnyTranscript,
  sniffAudioManifest,
  probeClassroom,
  ensureEchoLoggedIn,
  keepEchoSessionWarm,
  withEchoLock,
  type EchoLesson,
  type AudioManifest,
  type ClassroomProbe,
} from "./echo360.js";
export {
  discoverEchoSections,
  type DiscoveredSection,
  type DiscoveryResult,
} from "./echo-discover.js";
