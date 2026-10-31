import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";
import styles from "./Button.module.css";

// Buttons and button-styled links.
//   primary    cyan fill: the one main action in a view (Save, Generate next moves)
//   secondary  hairline on surface: most actions (Refresh, Check in, Retry)
//   ghost      text only: low-weight actions inside panels (Dismiss, Back)
//   ai         violet: actions on AI content (Re-run next moves)
// `loading` keeps the button's width, shows a spinner and `loadingLabel`, sets aria-busy and blocks
// clicks, so a double click sends one request.

export type ButtonVariant = "primary" | "secondary" | "ghost" | "ai";
export type ButtonSize = "sm" | "md";

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon before the label (16px inline SVG, aria-hidden). */
  icon?: ReactNode;
}

export interface ButtonProps extends CommonProps, ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  /** Label while loading, e.g. "Refreshing". Defaults to the normal label. */
  loadingLabel?: ReactNode;
}

function classes(variant: ButtonVariant, size: ButtonSize, extra?: string, iconOnly?: boolean) {
  return [styles.button, styles[variant], styles[size], iconOnly ? styles.iconOnly : "", extra]
    .filter(Boolean)
    .join(" ");
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className={styles.spinner} viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    icon,
    loading = false,
    loadingLabel,
    className,
    children,
    type = "button",
    disabled,
    onClick,
    ...rest
  },
  ref,
) {
  const iconOnly = !children && !!icon;
  return (
    <button
      ref={ref}
      type={type}
      className={classes(variant, size, className, iconOnly)}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      data-loading={loading || undefined}
      onClick={(e) => {
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...rest}
    >
      {loading ? <Spinner /> : icon ? <span className={styles.icon}>{icon}</span> : null}
      {loading ? (loadingLabel ?? children) : children}
    </button>
  );
});

export interface ButtonLinkProps extends CommonProps, AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  /** Opens in a new tab with rel="noopener noreferrer". Default true for http(s) links. */
  external?: boolean;
}

/** A link that looks like a button. External links open in a new tab safely. */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  href,
  external = /^https?:\/\//.test(href),
  ...rest
}: ButtonLinkProps) {
  return (
    <a
      href={href}
      className={classes(variant, size, className, !children && !!icon)}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      {...rest}
    >
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      {children}
    </a>
  );
}
