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
  type ForumPost,
  type SlideFile,
} from "./moodle-api.js";
export { openContext, profileDir } from "./session.js";
export type { ScrapeCounts } from "./moodle.js";
export {
  openEchoContext,
  activeEchoContext,
  echoConnected,
  echoVerify,
  loginEcho360,
  listLessons,
  fetchTranscript,
  sniffAudioManifest,
  withEchoLock,
  type EchoLesson,
  type AudioManifest,
} from "./echo360.js";
