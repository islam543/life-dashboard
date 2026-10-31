// Hash routes (docs/ARCHITECTURE.md "Web additions"). The hash is the whole router:
//
//   #/                Home (glance)
//   #/projects        Projects board         #/projects/<id>    one project (id URI-encoded)
//   #/notes           Notes                  #/notes/<path>     one note (path URI-encoded, "/" as %2F)
//   #/map             Life map (explore)
//
// Build links with toHash() / projectHash() / noteHash() rather than by hand, so ids and note
// paths with spaces, "/" or Arabic letters survive the round trip. Navigate by assigning
// window.location.hash; App.tsx listens for hashchange.

/** The four views in the header switch. */
export type View = "home" | "projects" | "notes" | "map";

export type HashRoute =
  | { view: "home" }
  | { view: "projects"; /** Project id, or null for the board. */ id: string | null }
  | { view: "notes"; /** Note path relative to NOTES_DIR, or null for the list. */ path: string | null }
  | { view: "map" };

/** Decoded, without leading or trailing slashes; null when empty or not valid percent-encoding. */
function param(raw: string): string | null {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  value = value.replace(/^\/+|\/+$/g, "");
  return value === "" ? null : value;
}

/** Reads `window.location.hash` (or any "#/..." string). Unknown routes fall back to Home. */
export function parseHash(hash: string): HashRoute {
  const route = hash.replace(/^#/, "").replace(/^\/+/, "");
  const slash = route.indexOf("/");
  const head = (slash === -1 ? route : route.slice(0, slash)).toLowerCase();
  const rest = slash === -1 ? "" : route.slice(slash + 1);
  switch (head) {
    case "projects":
      return { view: "projects", id: param(rest) };
    case "notes":
      return { view: "notes", path: param(rest) };
    case "map":
      return { view: "map" };
    default:
      return { view: "home" };
  }
}

/** The hash for a route, for href or window.location.hash. Inverse of parseHash. */
export function toHash(route: HashRoute): string {
  switch (route.view) {
    case "projects":
      return route.id ? `#/projects/${encodeURIComponent(route.id)}` : "#/projects";
    case "notes":
      return route.path ? `#/notes/${encodeURIComponent(route.path)}` : "#/notes";
    case "map":
      return "#/map";
    default:
      return "#/";
  }
}

/** "#/projects" or "#/projects/<id>". */
export function projectHash(id?: string | null): string {
  return toHash({ view: "projects", id: id ?? null });
}

/** "#/notes" or "#/notes/<path>". */
export function noteHash(path?: string | null): string {
  return toHash({ view: "notes", path: path ?? null });
}
