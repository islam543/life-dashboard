import { useCallback, useEffect, useState } from "react";
import type { Project } from "../../../shared/types";
import { errorMessage } from "../api";
import { projectsApi } from "../api/projects";

// Projects for the note editor's project select and the list's project chips. Read once when the
// Notes view opens; Retry re-reads. A failure never blocks writing: the select keeps the note's
// current link and says the list could not load.

export interface ProjectOptions {
  projects: Project[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useProjectOptions(): ProjectOptions {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    projectsApi.list(ctrl.signal).then(
      (state) => {
        setProjects(state.projects);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    return () => ctrl.abort();
  }, [attempt]);

  const reload = useCallback(() => setAttempt((a) => a + 1), []);
  return { projects, loading, error, reload };
}

/** Project id to name, for chips. Unknown ids (a deleted project, or projects not loaded) show the id. */
export function projectName(projects: readonly Project[] | null, id: string): string {
  return projects?.find((p) => p.id === id)?.name ?? id;
}
