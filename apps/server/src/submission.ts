/**
 * The assignment behind a calendar event, matched on its Learn link (or on the
 * event the app made for it). Matching on the due time alone is not enough:
 * two assignments in one course can share a deadline.
 */
export const EVENT_ASSIGNMENT = `(SELECT a.%s FROM assignments a
   WHERE a.course_id IS e.course_id
     AND (a.url = e.url OR e.id = 'assign-evt:' || a.id)
   LIMIT 1)`;

/** SQL for one column of an event's assignment, e.g. eventAssignment("status"). */
export const eventAssignment = (column: "id" | "status") => EVENT_ASSIGNMENT.replace("%s", column);

/** Handed in on Learn, so there's nothing left to do for it. */
export const isHandedIn = (status: string | null | undefined) => status === "submitted" || status === "graded";
