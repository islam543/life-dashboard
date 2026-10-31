import { createContext, createElement, memo, useContext, type ComponentPropsWithoutRef } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./MarkdownPreview.module.css";

// Read view of a note: react-markdown + remark-gfm. Raw HTML in a note is shown as text, never
// rendered (no rehype-raw), and react-markdown's default URL filter drops javascript: and similar
// links. Links open in a new tab without access to this page. Images are not fetched: they show as a
// link (a remote image would phone home, and vault-relative paths would not load here anyway).
// Task checkboxes are live: ticking one flips the matching "- [ ]" line in the source.

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
  properties?: Record<string, unknown>;
  position?: { start: { line: number } };
}

interface TaskContextValue {
  line: number;
  label: string;
}

const TaskContext = createContext<TaskContextValue | null>(null);
const ToggleContext = createContext<((line: number) => void) | null>(null);

/** Text of a list item without its nested lists, for the checkbox's accessible name. */
function itemText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "ul" || node.tagName === "ol") return "";
  return (node.children ?? []).map(itemText).join("");
}

function hasClass(node: HastNode | undefined, name: string): boolean {
  const cls = node?.properties?.className;
  return Array.isArray(cls) ? cls.includes(name) : cls === name;
}

type WithNode<T extends keyof JSX.IntrinsicElements> = ComponentPropsWithoutRef<T> & ExtraProps;

function ListItem({ node, children, ...rest }: WithNode<"li">) {
  const hast = node as unknown as HastNode | undefined;
  const line = hast?.position?.start.line;
  const li = (
    <li dir="auto" {...rest}>
      {children}
    </li>
  );
  if (!hasClass(hast, "task-list-item") || !line) return li;
  return <TaskContext.Provider value={{ line, label: itemText(hast).trim() || "Task" }}>{li}</TaskContext.Provider>;
}

function Input({ node: _node, ...rest }: WithNode<"input">) {
  const task = useContext(TaskContext);
  const toggle = useContext(ToggleContext);
  if (rest.type !== "checkbox" || !task || !toggle) return <input {...rest} disabled />;
  return (
    <input
      type="checkbox"
      className={styles.check}
      checked={!!rest.checked}
      aria-label={task.label}
      onChange={() => toggle(task.line)}
      data-tip="Ticks or unticks this task in the note's markdown; it saves at once."
    />
  );
}

/** A markdown link title ([text](url "title")) becomes the hover tip, so there is never a second, native tooltip. */
function Link({ node: _node, children, href, title, ...rest }: WithNode<"a">) {
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer" data-tip={title || "Opens this link in a new browser tab."}>
      {children}
    </a>
  );
}

function Image({ src, alt }: WithNode<"img">) {
  if (!src) return <span className={styles.imageNote}>[image{alt ? `: ${alt}` : ""}]</span>;
  return (
    <a
      className={styles.imageNote}
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      data-tip="Opens the image in a new tab; the preview never loads images itself."
    >
      Image{alt ? `: ${alt}` : ""}
    </a>
  );
}

/** Block elements get dir="auto" so an Arabic paragraph reads right to left inside an English note. */
function auto<T extends "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "td" | "th">(tag: T) {
  return function AutoDir({ node: _node, ...rest }: WithNode<T>) {
    return createElement(tag as string, { dir: "auto", ...rest });
  };
}

const COMPONENTS: Components = {
  li: ListItem,
  input: Input,
  a: Link,
  img: Image,
  p: auto("p"),
  h1: auto("h1"),
  h2: auto("h2"),
  h3: auto("h3"),
  h4: auto("h4"),
  h5: auto("h5"),
  h6: auto("h6"),
  blockquote: auto("blockquote"),
  td: auto("td"),
  th: auto("th"),
  table: ({ node: _node, ...rest }) => (
    <div className={styles.tableWrap}>
      <table {...rest} />
    </div>
  ),
};

const PLUGINS = [remarkGfm];

export interface MarkdownPreviewProps {
  markdown: string;
  /** Flip the task on this 1-based source line. */
  onToggleTask: (line: number) => void;
  /** Shown when the note has no text yet. */
  empty?: string;
}

export const MarkdownPreview = memo(function MarkdownPreview({
  markdown,
  onToggleTask,
  empty = "Nothing to preview yet. Switch to Write to add text.",
}: MarkdownPreviewProps) {
  if (!markdown.trim()) {
    return <p className={styles.empty}>{empty}</p>;
  }
  return (
    <ToggleContext.Provider value={onToggleTask}>
      <div className={styles.prose}>
        <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
          {markdown}
        </Markdown>
      </div>
    </ToggleContext.Provider>
  );
});
