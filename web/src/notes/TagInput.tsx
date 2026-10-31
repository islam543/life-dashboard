import { useId, useRef, useState } from "react";
import { addTag, MAX_TAGS } from "../lib/notes";
import { CloseIcon } from "./icons";
import styles from "./NoteEditor.module.css";

// Tags as chips. Type a tag and press Enter, comma or space; Backspace in an empty field removes the
// last one. A leading "#" is dropped (Obsidian style). Rules match the server: up to 10 tags of 30
// letters, numbers or hyphens.

export interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  /** Called when the field loses focus, so the editor can save. */
  onBlur?: () => void;
}

export function TagInput({ tags, onChange, onBlur }: TagInputProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uid = useId().replace(/:/g, "");
  const labelId = `tags-label-${uid}`;
  const errorId = `tags-error-${uid}`;
  const hintId = `tags-hint-${uid}`;

  const commit = (raw: string): boolean => {
    const result = addTag(tags, raw);
    setError(result.error);
    if (result.error) return false;
    if (result.tags.length !== tags.length) onChange(result.tags);
    setText("");
    return true;
  };

  const remove = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
    setError(null);
    inputRef.current?.focus();
  };

  return (
    <div className={styles.field}>
      <span id={labelId} className={styles.fieldLabel}>
        Tags
      </span>
      <div
        className={styles.tagBox}
        data-invalid={error ? "" : undefined}
        onClick={() => inputRef.current?.focus()}
        data-tip={tags.length >= MAX_TAGS ? `Holds the most tags a note can have (${MAX_TAGS}); remove one to add another.` : undefined}
      >
        <ul className={styles.tagList} aria-label="Tags on this note">
          {tags.map((tag) => (
            <li key={tag} className={styles.tag}>
              <span dir="auto">{tag}</span>
              <button
                type="button"
                className={styles.tagRemove}
                aria-label={`Remove tag ${tag}`}
                data-tip="Removes this tag from the note; it saves at once."
                onClick={(e) => {
                  e.stopPropagation();
                  remove(tag);
                }}
              >
                <CloseIcon size={12} />
              </button>
            </li>
          ))}
        </ul>
        {tags.length < MAX_TAGS ? (
          <input
            ref={inputRef}
            className={styles.tagInput}
            value={text}
            dir="auto"
            aria-labelledby={labelId}
            aria-describedby={error ? errorId : hintId}
            aria-invalid={error ? true : undefined}
            data-tip={`Adds tags to the note: type one, then Enter, comma or space; up to ${MAX_TAGS}, saved at once.`}
            enterKeyHint="done"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              const value = e.target.value;
              // A pasted "a, b c" adds every complete tag and keeps typing on the last one.
              if (/[,\s]/.test(value)) {
                const parts = value.split(/[,\s]+/);
                const rest = parts.pop() ?? "";
                let next = tags;
                for (const part of parts) {
                  const r = addTag(next, part);
                  if (r.error) {
                    setError(r.error);
                    setText(value.replace(/[,\s]+$/, ""));
                    return;
                  }
                  next = r.tags;
                }
                if (next !== tags) onChange(next);
                setError(null);
                setText(rest);
                return;
              }
              setText(value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit(text);
              } else if (e.key === "Backspace" && text === "" && tags.length > 0) {
                e.preventDefault();
                onChange(tags.slice(0, -1));
              }
            }}
            onBlur={() => {
              if (text.trim()) commit(text);
              onBlur?.();
            }}
            placeholder={tags.length === 0 ? "Add a tag" : undefined}
          />
        ) : null}
      </div>
      {error ? (
        <p id={errorId} className={styles.fieldError}>
          {error}
        </p>
      ) : (
        <p id={hintId} className="sr-only">
          Press Enter, comma or space after each tag. Up to {MAX_TAGS} tags.
        </p>
      )}
    </div>
  );
}
