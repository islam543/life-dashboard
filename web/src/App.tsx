import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useState } from "react";
import { CheckinProvider } from "./context/CheckinContext";
import { DetailProvider } from "./context/DetailContext";
import { MOTION } from "./hooks/useReducedMotion";
import { parseHash, type HashRoute, type View } from "./lib/route";
import { AppShell } from "./shell/AppShell";
import { Home } from "./views/Home";
import { LifeMap } from "./views/LifeMap";
import { Notes } from "./views/Notes";
import { Projects } from "./views/Projects";
import { Backdrop } from "./ui/Backdrop";
import { ContextMenuLayer } from "./ui/ContextMenu";
import { TipLayer } from "./ui/TipLayer";

// Routes live in the hash (see lib/route.ts): "#/" Home (glance), "#/projects[/<id>]",
// "#/notes[/<path>]", "#/map" Life map (explore).

const TITLES: Record<View, string> = {
  home: "Life dashboard",
  projects: "Projects | Life dashboard",
  notes: "Notes | Life dashboard",
  map: "Life map | Life dashboard",
};

function useHashRoute(): HashRoute {
  const [route, setRoute] = useState<HashRoute>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function CurrentView({ route }: { route: HashRoute }) {
  switch (route.view) {
    case "projects":
      return <Projects id={route.id} />;
    case "notes":
      return <Notes path={route.path} />;
    case "map":
      return <LifeMap />;
    default:
      return <Home />;
  }
}

export default function App() {
  const route = useHashRoute();

  // Runs after AppShell's own title effect (a parent's effects run after its children's), so it wins.
  useEffect(() => {
    document.title = TITLES[route.view];
  }, [route.view]);

  return (
    // reducedMotion="user": under prefers-reduced-motion, motion skips transform and layout animations.
    <MotionConfig reducedMotion="user">
      <DetailProvider>
        <CheckinProvider>
          <Backdrop />
          <AppShell route={route.view}>
            <AnimatePresence mode="wait" initial={false}>
              {/* Keyed by view only: opening a project or note inside a view keeps the view mounted. */}
              <motion.div
                key={route.view}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: MOTION.fast, ease: MOTION.easeOut }}
              >
                <CurrentView route={route} />
              </motion.div>
            </AnimatePresence>
          </AppShell>
          <ContextMenuLayer />
          <TipLayer />
        </CheckinProvider>
      </DetailProvider>
    </MotionConfig>
  );
}
