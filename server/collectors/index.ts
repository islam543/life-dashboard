// Collector registry. Final as of T01: each collector ticket edits only its own file,
// never this one. See types.ts for the contract.
import { calendarCollector } from "./calendar";
import { checkinsCollector } from "./checkins";
import { claudeSessionsCollector } from "./claudeSessions";
import { emailCollector } from "./email";
import { githubCollector } from "./github";
import { jiraCollector } from "./jira";
import { learningCollector } from "./learning";
import type { CollectorRegistry } from "./types";

export const collectors: CollectorRegistry = {
  github: githubCollector,
  jira: jiraCollector,
  claudeSessions: claudeSessionsCollector,
  learning: learningCollector,
  checkins: checkinsCollector,
  calendar: calendarCollector,
  email: emailCollector,
};

export { SOURCE_KEYS } from "./types";
export type { Collector, CollectorContext, CollectorRegistry, CollectorResult, CollectorSlices, SourceKey } from "./types";
