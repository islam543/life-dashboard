import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { Checkin } from "../../../shared/types";
import { api, ApiRequestError, errorMessage, isOffline } from "../api";
import { useCheckin } from "../context/CheckinContext";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useSnapshot } from "../hooks/useSnapshot";
import { dayKey, formatLongDate } from "../lib/format";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/StatusDot";
import {
  addDays,
  CHECKIN_LIMITS,
  checkinErrors,
  earliestCheckinDate,
  ENERGY_WORDS,
  findCheckin,
  firstErrorField,
  initialValues,
  MOOD_WORDS,
  noteLength,
  parseDayKey,
  parseDecimal,
  SCALE,
  stepSleep,
  validateCheckinForm,
  WORKOUT_PICKS,
  type CheckinErrors,
  type CheckinField,
  type CheckinFormValues,
  type Scale,
  type WorkoutPick,
} from "./checkinForm";
import styles from "./CheckinDialog.module.css";

// The 30-second evening check-in. Always mounted by shell/AppShell; opens when useCheckin().isOpen
// is true, on useCheckin().date. Keyboard path: focus starts in Sleep (arrows step 0.5 h), Tab to
// Energy and Mood (arrows or keys 1 to 5), Tab to Workout (arrows), Tab to Spent, Enter saves.
// On save: POST /api/checkin, adopt the returned Snapshot with useSnapshot().replace(), show the
// check mark, then closeCheckin() (which returns focus to the opener). Escape closes an untouched
// form; with answers typed, the first Escape warns and the second discards.

const EMPTY: readonly Checkin[] = [];
const CLOSE_AFTER_MS = 1200;
const CLOSE_AFTER_REDUCED_MS = 900;
const NOTE_WARN_AT = 50;
const WORKOUT_OPTIONS: readonly WorkoutPick[] = [...WORKOUT_PICKS, "custom"];

export function CheckinDialog() {
  const { isOpen, date, closeCheckin } = useCheckin();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = `checkin-title-${useId().replace(/:/g, "")}`;
  const busy = useRef(false);
  const pristine = useRef(true);
  const pressedBackdrop = useRef(false);

  // A fresh form for every opening, so a closed draft never leaks into the next check-in.
  const [session, setSession] = useState(0);
  const [wasOpen, setWasOpen] = useState(isOpen);
  // Escape on a form with answers asks first: the first press shows "Press Esc again to discard",
  // the second closes. Any edit in between takes the warning back.
  const [discardArmed, setDiscardArmed] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    setDiscardArmed(false);
    if (isOpen) setSession((s) => s + 1);
  }

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      dialog.showModal();
      const first = dialog.querySelector<HTMLInputElement>("[data-autofocus]");
      if (first) {
        first.focus();
        first.select();
      }
    }
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      // Escape closes through the context, so its state never waits on the async "close" event
      // (Chromium fires it on the next frame). Ignored while saving: closing would hide the outcome.
      // With typed answers the first Escape only warns, like the backdrop that never discards them.
      // onClose still covers a close the browser forces on its own (Chromium may close on a second
      // Escape without a cancel event, which is the same outcome as the second press here).
      onCancel={(e) => {
        e.preventDefault();
        if (busy.current) return;
        if (pristine.current || discardArmed) closeCheckin();
        else setDiscardArmed(true);
      }}
      onClose={closeCheckin}
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // A click on the dimmed backdrop closes an untouched form; typed answers are never thrown away.
        const onBackdrop = pressedBackdrop.current && e.target === e.currentTarget;
        pressedBackdrop.current = false;
        if (onBackdrop && pristine.current && !busy.current) closeCheckin();
      }}
    >
      {session > 0 ? (
        <CheckinForm
          key={session}
          initialDate={date}
          titleId={titleId}
          busyRef={busy}
          pristineRef={pristine}
          discardArmed={discardArmed}
          onEdit={() => setDiscardArmed(false)}
          onClose={closeCheckin}
        />
      ) : null}
    </dialog>
  );
}

interface FormProps {
  initialDate: string;
  titleId: string;
  busyRef: MutableRefObject<boolean>;
  pristineRef: MutableRefObject<boolean>;
  /** The first Escape on a changed form was pressed: show "Press Esc again to discard". */
  discardArmed: boolean;
  /** Called on every edit, so a warning shown earlier is taken back. */
  onEdit: () => void;
  onClose: () => void;
}

type Phase = "idle" | "saving" | "saved";

interface Failure {
  message: string;
  /** Server down or a 5xx: the same answers can be sent again. A 400 needs a change first. */
  retry: boolean;
  offline: boolean;
}

/** "Thursday 30 October", plus the year when it is not this year. */
function longDay(date: string, today: string): string | null {
  const parsed = parseDayKey(date);
  if (!parsed) return null;
  return date.slice(0, 4) === today.slice(0, 4) ? formatLongDate(parsed) : `${formatLongDate(parsed)} ${parsed.getFullYear()}`;
}

function titleFor(date: string, today: string): string {
  if (date === today) return "Today's check-in";
  if (date === addDays(today, -1)) return "Yesterday's check-in";
  const day = longDay(date, today);
  return day ? `Check-in for ${day}` : "Check-in";
}

/** Server messages arrive with or without a final period; show them as one sentence. */
function asSentence(message: string): string {
  const text = message.trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function withError(errors: CheckinErrors, field: CheckinField, message: string | undefined): CheckinErrors {
  if (errors[field] === message) return errors;
  const next = { ...errors };
  if (message === undefined) delete next[field];
  else next[field] = message;
  return next;
}

function CheckinForm({ initialDate, titleId, busyRef, pristineRef, discardArmed, onEdit, onClose }: FormProps) {
  const snap = useSnapshot();
  const reduced = useReducedMotion();
  const checkins = snap.data?.personal.checkins ?? EMPTY;
  const [today] = useState(() => dayKey(new Date()));
  const [values, setValues] = useState<CheckinFormValues>(() => initialValues(checkins, initialDate));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<CheckinErrors>({});
  const [attempted, setAttempted] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<Failure | null>(null);
  const inflight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const customRef = useRef<HTMLInputElement>(null);
  const uid = useId().replace(/:/g, "");
  const id = (name: string) => `ci-${uid}-${name}`;

  busyRef.current = phase === "saving";
  pristineRef.current = !dirty;

  // The snapshot arrived or changed while the form is untouched: show that day's saved answers.
  // Only the data is a dependency on purpose; the first edit flips `dirty` and stops this.
  useEffect(() => {
    if (dirty || phase !== "idle") return;
    setValues((v) => (parseDayKey(v.date) ? initialValues(checkins, v.date) : v));
  }, [checkins]); // eslint-disable-line react-hooks/exhaustive-deps

  // Saved: freeze the form, show the check mark, then close.
  useEffect(() => {
    if (phase !== "saved") return;
    formRef.current?.setAttribute("inert", "");
    doneRef.current?.focus({ preventScroll: true });
    const timer = setTimeout(onClose, reduced ? CLOSE_AFTER_REDUCED_MS : CLOSE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [phase, reduced, onClose]);

  useEffect(() => {
    if (failure) alertRef.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);

  const savedForDay = findCheckin(checkins, values.date);
  const title = titleFor(values.date, today);
  const savedDay = longDay(values.date, today);

  /** Apply an edit. Rechecks the edited field once a save was tried or while it shows an error. */
  const change = (patch: Partial<CheckinFormValues>, field: CheckinField) => {
    const next = { ...values, ...patch };
    setValues(next);
    setDirty(true);
    onEdit();
    if (attempted || errors[field] !== undefined) {
      setErrors((prev) => withError(prev, field, checkinErrors(next, today)[field]));
    }
  };

  /** Format check when leaving a typed field. An empty field the user only tabbed past is not flagged. */
  const blurCheck = (field: CheckinField, raw: string) => {
    if (raw.trim() === "" && !attempted) return;
    setErrors((prev) => withError(prev, field, checkinErrors(values, today)[field]));
  };

  const changeDate = (date: string) => {
    // Untouched form: load that day's saved answers, or a fresh form. Typed answers are kept.
    const next = !dirty && parseDayKey(date) ? initialValues(checkins, date) : { ...values, date };
    setValues(next);
    if (attempted) setErrors(checkinErrors(next, today));
    else if (errors.date !== undefined) setErrors((prev) => withError(prev, "date", checkinErrors(next, today).date));
  };

  const focusField = (field: CheckinField | null) => {
    if (!field) return;
    const scope = formRef.current?.querySelector(`[data-field="${field}"]`);
    const target =
      scope?.querySelector<HTMLElement>("[data-primary]") ??
      scope?.querySelector<HTMLElement>("input:checked") ??
      scope?.querySelector<HTMLElement>("input, textarea");
    target?.focus();
  };

  const save = async () => {
    if (inflight.current || phase !== "idle") return;
    setAttempted(true);
    const result = validateCheckinForm(values, today);
    if (!result.ok) {
      setErrors(result.errors);
      focusField(firstErrorField(result.errors));
      return;
    }
    setErrors({});
    setFailure(null);
    inflight.current = true;
    setPhase("saving");
    try {
      const snapshot = await api.postCheckin(result.payload);
      snap.replace(snapshot);
      setPhase("saved");
    } catch (err) {
      const status = err instanceof ApiRequestError ? err.status : 0;
      setFailure({ message: errorMessage(err), retry: status !== 400, offline: isOffline(err) });
      setPhase("idle");
    } finally {
      inflight.current = false;
    }
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void save();
  };

  // Enter saves from any field. In the note, Shift+Enter adds a line. Buttons keep their own Enter.
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement) return;
    if (target instanceof HTMLTextAreaElement && e.shiftKey) return;
    e.preventDefault();
    formRef.current?.requestSubmit();
  };

  const stepBy = (direction: 1 | -1) => {
    const fallback = parseDecimal(initialValues(checkins, values.date).sleepHours) ?? 7;
    change({ sleepHours: stepSleep(values.sleepHours, direction, fallback) }, "sleepHours");
  };

  const sleepNumber = parseDecimal(values.sleepHours);
  const sleepValid = sleepNumber !== null && !Number.isNaN(sleepNumber);
  const noteLen = noteLength(values.note);
  const noteLeft = CHECKIN_LIMITS.noteMaxLength - noteLen;

  const describe = (field: CheckinField, ...extra: string[]) =>
    [...extra, ...(errors[field] !== undefined ? [id(`${field}-error`)] : [])].join(" ") || undefined;

  let dayNote: string;
  if (!snap.data && snap.loading) dayNote = "Loading your past check-ins";
  else if (!snap.data) dayNote = "Past check-ins did not load. You can still save.";
  else if (savedForDay) dayNote = "Already saved. Saving again replaces it.";
  else dayNote = "Not saved yet";

  return (
    <>
      <form ref={formRef} className={styles.form} noValidate onSubmit={onSubmit} onKeyDown={onKeyDown}>
        <header className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <Button
            variant="ghost"
            size="sm"
            icon={<CloseIcon />}
            aria-label="Close check-in"
            title="Close (Esc)"
            onClick={onClose}
            disabled={phase === "saving"}
            className={styles.close}
          />
        </header>

        <div className={styles.body}>
          {failure ? (
            <div ref={alertRef} className={styles.alert} role="alert">
              <StatusDot tone="danger" size={10} glow={false} />
              <div className={styles.alertText}>
                <p className={styles.alertTitle}>
                  {failure.offline ? "Couldn't reach the dashboard server." : "Couldn't save this check-in."}
                </p>
                <p>
                  {failure.offline
                    ? "Your answers are still here. Check that npm run dev is running, then retry."
                    : failure.retry
                      ? `${asSentence(failure.message)} Your answers are still here.`
                      : `The server said: ${asSentence(failure.message)}`}
                </p>
              </div>
              {failure.retry ? (
                <Button size="sm" onClick={() => formRef.current?.requestSubmit()}>
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}

          <Row field="date" label="Day" htmlFor={id("date")} error={errors.date} errorId={id("date-error")}>
            <div className={styles.dayControl}>
              <input
                id={id("date")}
                type="date"
                className={`${styles.input} ${styles.dateInput}`}
                value={values.date}
                min={earliestCheckinDate(today)}
                max={today}
                onChange={(e) => changeDate(e.target.value)}
                onBlur={(e) => blurCheck("date", e.target.value)}
                aria-invalid={errors.date !== undefined || undefined}
                aria-describedby={describe("date", id("day-note"))}
              />
              <span id={id("day-note")} className={styles.dayNote} data-saved={savedForDay ? "" : undefined}>
                {savedForDay ? <StatusDot tone="ok" size={7} glow={false} /> : null}
                {dayNote}
              </span>
            </div>
          </Row>

          <Row
            field="sleepHours"
            label="Sleep"
            unit="hours"
            htmlFor={id("sleep")}
            error={errors.sleepHours}
            errorId={id("sleepHours-error")}
          >
            <div className={styles.stepper}>
              <button
                type="button"
                tabIndex={-1}
                className={styles.stepButton}
                aria-label="Half an hour less sleep"
                onClick={() => stepBy(-1)}
              >
                <MinusIcon />
              </button>
              <input
                id={id("sleep")}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                role="spinbutton"
                aria-valuemin={CHECKIN_LIMITS.sleepHours.min}
                aria-valuemax={CHECKIN_LIMITS.sleepHours.max}
                aria-valuenow={sleepValid ? (sleepNumber as number) : undefined}
                aria-valuetext={sleepValid ? `${values.sleepHours} hours` : undefined}
                aria-invalid={errors.sleepHours !== undefined || undefined}
                aria-describedby={describe("sleepHours")}
                data-autofocus=""
                data-primary=""
                className={`${styles.input} ${styles.stepInput}`}
                value={values.sleepHours}
                onChange={(e) => change({ sleepHours: e.target.value }, "sleepHours")}
                onBlur={(e) => blurCheck("sleepHours", e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                    e.preventDefault();
                    stepBy(e.key === "ArrowUp" ? 1 : -1);
                  }
                }}
              />
              <button
                type="button"
                tabIndex={-1}
                className={styles.stepButton}
                aria-label="Half an hour more sleep"
                onClick={() => stepBy(1)}
              >
                <PlusIcon />
              </button>
            </div>
          </Row>

          <ScaleRow
            field="energy"
            label="Energy"
            words={ENERGY_WORDS}
            value={values.energy}
            name={id("energy")}
            labelId={id("energy-label")}
            error={errors.energy}
            errorId={id("energy-error")}
            onPick={(n) => change({ energy: n }, "energy")}
          />

          <ScaleRow
            field="mood"
            label="Mood"
            words={MOOD_WORDS}
            value={values.mood}
            name={id("mood")}
            labelId={id("mood-label")}
            error={errors.mood}
            errorId={id("mood-error")}
            onPick={(n) => change({ mood: n }, "mood")}
          />

          <Row
            field="workoutMinutes"
            label="Workout"
            unit="minutes"
            labelId={id("workout-label")}
            error={errors.workoutMinutes}
            errorId={id("workoutMinutes-error")}
          >
            <div
              role="radiogroup"
              aria-labelledby={id("workout-label")}
              aria-describedby={values.workoutPick === "custom" ? undefined : describe("workoutMinutes")}
              className={styles.segments}
              data-count={WORKOUT_OPTIONS.length}
            >
              {WORKOUT_OPTIONS.map((pick) => (
                <label
                  key={pick}
                  className={styles.segment}
                  data-flat=""
                  onClick={(e) => {
                    // Pointer users go straight to typing; keyboard users Tab there, so arrows still wrap.
                    if (pick === "custom" && e.detail > 0) requestAnimationFrame(() => customRef.current?.focus());
                  }}
                >
                  <input
                    type="radio"
                    className={styles.segmentInput}
                    name={id("workout")}
                    value={String(pick)}
                    checked={values.workoutPick === pick}
                    onChange={() => change({ workoutPick: pick }, "workoutMinutes")}
                  />
                  {pick === "custom" ? (
                    <span className={styles.segmentWord}>Custom</span>
                  ) : (
                    <span className={`num ${styles.segmentNum}`}>{pick}</span>
                  )}
                </label>
              ))}
            </div>
            {values.workoutPick === "custom" ? (
              <div className={styles.custom}>
                <label htmlFor={id("workout-custom")} className={styles.customLabel}>
                  Custom minutes
                </label>
                <div className={`${styles.affix} ${styles.customField}`}>
                  <input
                    ref={customRef}
                    id={id("workout-custom")}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    data-primary=""
                    className={styles.input}
                    value={values.workoutCustom}
                    onChange={(e) => change({ workoutCustom: e.target.value }, "workoutMinutes")}
                    onBlur={(e) => blurCheck("workoutMinutes", e.target.value)}
                    aria-invalid={errors.workoutMinutes !== undefined || undefined}
                    aria-describedby={describe("workoutMinutes")}
                  />
                  <span className={styles.suffix} aria-hidden="true">
                    min
                  </span>
                </div>
              </div>
            ) : null}
          </Row>

          <Row
            field="spendQar"
            label="Spent"
            unit="QAR"
            htmlFor={id("spend")}
            error={errors.spendQar}
            errorId={id("spendQar-error")}
          >
            <div className={`${styles.affix} ${styles.spendField}`}>
              <input
                id={id("spend")}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                className={styles.input}
                value={values.spendQar}
                onChange={(e) => change({ spendQar: e.target.value }, "spendQar")}
                onBlur={(e) => blurCheck("spendQar", e.target.value)}
                aria-invalid={errors.spendQar !== undefined || undefined}
                aria-describedby={describe("spendQar")}
              />
              <span className={styles.suffix} aria-hidden="true">
                QAR
              </span>
            </div>
          </Row>

          <Row field="note" label="Note" unit="optional" htmlFor={id("note")} error={errors.note} errorId={id("note-error")}>
            <textarea
              id={id("note")}
              rows={2}
              className={`${styles.input} ${styles.note}`}
              value={values.note}
              onChange={(e) => change({ note: e.target.value }, "note")}
              onBlur={(e) => blurCheck("note", e.target.value)}
              aria-invalid={errors.note !== undefined || undefined}
              aria-describedby={describe("note", id("note-count"))}
            />
            <div className={styles.noteMeta}>
              <span className={styles.noteHint} aria-hidden="true">
                <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
              </span>
              <span
                id={id("note-count")}
                className={`num ${styles.counter}`}
                data-tone={noteLeft < 0 ? "over" : noteLeft <= NOTE_WARN_AT ? "near" : undefined}
              >
                {noteLen}/{CHECKIN_LIMITS.noteMaxLength}
                <span className="sr-only"> characters</span>
              </span>
            </div>
            <span className="sr-only" aria-live="polite">
              {noteLeft < 0
                ? `${-noteLeft} characters too many`
                : noteLeft <= NOTE_WARN_AT
                  ? `${noteLeft} characters left`
                  : ""}
            </span>
          </Row>
        </div>

        <footer className={styles.foot}>
          {/* The live region stays mounted so the warning is announced when it appears. */}
          <p className={styles.discard} role="status">
            {discardArmed ? (
              <>
                <StatusDot tone="warn" size={9} glow={false} />
                <span>
                  Press <kbd>Esc</kbd> again to discard your answers
                </span>
              </>
            ) : null}
          </p>
          {discardArmed ? null : (
            <p className={styles.keys} aria-hidden="true">
              <kbd>Enter</kbd> save <kbd>Esc</kbd> close
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            loading={phase === "saving"}
            loadingLabel="Saving"
            className={styles.save}
          >
            Save check-in
          </Button>
        </footer>
      </form>

      {phase === "saved" ? (
        <div className={styles.done} role="status">
          <svg className={styles.mark} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
            <circle className={styles.markPulse} cx="32" cy="32" r="26" />
            <circle className={styles.markRing} cx="32" cy="32" r="26" pathLength={100} />
            <path className={styles.markCheck} d="M21 33.5l7.5 7.5L44 25" pathLength={100} />
          </svg>
          <h3 ref={doneRef} tabIndex={-1} className={styles.doneTitle}>
            Check-in saved
          </h3>
          {savedDay ? <p className={styles.doneMeta}>{savedDay}</p> : null}
        </div>
      ) : null}
    </>
  );
}

/* Rows ----------------------------------------------------------------------------------------- */

interface RowProps {
  field: CheckinField;
  label: string;
  unit?: string;
  /** For a single control: the label points at it. */
  htmlFor?: string;
  /** For a group: the id its aria-labelledby points at. */
  labelId?: string;
  error: string | undefined;
  errorId: string;
  children: ReactNode;
}

function Row({ field, label, unit, htmlFor, labelId, error, errorId, children }: RowProps) {
  const text = (
    <>
      <span className={styles.labelText}>{label}</span>
      {unit ? <span className={styles.unit}>{unit}</span> : null}
    </>
  );
  return (
    <div className={styles.row} data-field={field} data-invalid={error !== undefined ? "" : undefined}>
      <div className={styles.rowLabel}>
        {htmlFor ? (
          <label htmlFor={htmlFor} id={labelId} className={styles.labelBox}>
            {text}
          </label>
        ) : (
          <span id={labelId} className={styles.labelBox}>
            {text}
          </span>
        )}
      </div>
      <div className={styles.rowControl}>
        {children}
        {error !== undefined ? (
          <p id={errorId} className={styles.error}>
            <StatusDot tone="danger" size={8} glow={false} />
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

interface ScaleRowProps {
  field: "energy" | "mood";
  label: string;
  words: Record<Scale, string>;
  value: Scale | null;
  name: string;
  labelId: string;
  error: string | undefined;
  errorId: string;
  onPick: (n: Scale) => void;
}

/** 1 to 5 as segmented radio buttons. Arrows move (native radios); keys 1 to 5 pick directly. */
function ScaleRow({ field, label, words, value, name, labelId, error, errorId, onPick }: ScaleRowProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > 5) return;
    e.preventDefault();
    onPick(n as Scale);
    e.currentTarget.querySelector<HTMLInputElement>(`input[value="${n}"]`)?.focus();
  };

  return (
    <Row field={field} label={label} unit="1 to 5" labelId={labelId} error={error} errorId={errorId}>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={error !== undefined ? errorId : undefined}
        className={styles.segments}
        data-count={SCALE.length}
        onKeyDown={onKeyDown}
      >
        {SCALE.map((n) => (
          <label key={n} className={styles.segment}>
            <input
              type="radio"
              className={styles.segmentInput}
              name={name}
              value={n}
              checked={value === n}
              onChange={() => onPick(n)}
            />
            <span className={`num ${styles.segmentNum}`}>{n}</span>
            <span className={styles.segmentWord}>{words[n]}</span>
          </label>
        ))}
      </div>
    </Row>
  );
}

/* Icons ---------------------------------------------------------------------------------------- */

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
