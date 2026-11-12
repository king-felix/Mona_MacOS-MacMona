import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type JSX,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  InfoIcon,
  PauseIcon,
  PlayIcon,
  WarningIcon,
  ClockIcon,
} from "./icons";

export type Tone = "neutral" | "primary" | "success" | "attention" | "danger" | "accent";

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ buttons */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  icon?: ReactNode;
  trailing?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  trailing,
  className,
  type,
  children,
  ...props
}: ButtonProps): JSX.Element {
  return (
    <button
      type={type ?? "button"}
      className={cx("button", `button--${variant}`, size === "sm" && "button--sm", className)}
      {...props}
    >
      {icon ? <span className="button__icon">{icon}</span> : null}
      <span className="button__label">{children}</span>
      {trailing ? <span className="button__icon">{trailing}</span> : null}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
  variant?: "ghost" | "secondary";
}

/** An icon-only control must carry an accessible name; the prop is required. */
export function IconButton({
  label,
  children,
  variant = "ghost",
  className,
  ...props
}: IconButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={cx("icon-button", `icon-button--${variant}`, className)}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ fields */

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string | null;
  id?: string;
  children: (ids: { inputId: string; describedBy: string | undefined }) => ReactNode;
}

export function Field({ label, hint, error, id, children }: FieldProps): JSX.Element {
  const generated = useId();
  const inputId = id ?? `field-${generated}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      {children({ inputId, describedBy })}
      {hint ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field__error" id={errorId}>
          <WarningIcon size={14} /> {error}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | null;
  mono?: boolean;
}

export function TextField({
  label,
  hint,
  error,
  mono,
  className,
  id,
  ...props
}: TextFieldProps): JSX.Element {
  return (
    <Field label={label} hint={hint} error={error} id={id}>
      {({ inputId, describedBy }) => (
        <input
          id={inputId}
          className={cx("input", mono && "input--mono", className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...props}
        />
      )}
    </Field>
  );
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
  error?: string | null;
}

export function TextArea({
  label,
  hint,
  error,
  className,
  id,
  ...props
}: TextAreaProps): JSX.Element {
  return (
    <Field label={label} hint={hint} error={error} id={id}>
      {({ inputId, describedBy }) => (
        <textarea
          id={inputId}
          className={cx("input", "input--area", className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...props}
        />
      )}
    </Field>
  );
}

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: string;
  error?: string | null;
  options: Array<{ value: string; label: string }>;
}

export function SelectField({
  label,
  hint,
  error,
  options,
  className,
  id,
  ...props
}: SelectFieldProps): JSX.Element {
  return (
    <Field label={label} hint={hint} error={error} id={id}>
      {({ inputId, describedBy }) => (
        <div className="select">
          <select
            id={inputId}
            className={cx("input", "select__control", className)}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            {...props}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDownIcon size={16} className="select__chevron" />
        </div>
      )}
    </Field>
  );
}

/* -------------------------------------------------------------------- tabs */

export interface TabDefinition {
  id: string;
  label: string;
  icon?: ReactNode;
}

export interface TabsProps {
  label: string;
  tabs: TabDefinition[];
  value: string;
  onChange: (id: string) => void;
}

export function Tabs({ label, tabs, value, onChange }: TabsProps): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === value),
  );
  const move = (next: number) => {
    const bounded = (next + tabs.length) % tabs.length;
    const tab = tabs[bounded];
    if (!tab) return;
    onChange(tab.id);
    refs.current[bounded]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, tabIndex) => (
        <button
          key={tab.id}
          ref={(node) => {
            refs.current[tabIndex] = node;
          }}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={tab.id === value}
          aria-controls={`panel-${tab.id}`}
          tabIndex={tab.id === value ? 0 : -1}
          className={cx("tab", tab.id === value && "tab--selected")}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              move(index + 1);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              move(index - 1);
            } else if (event.key === "Home") {
              event.preventDefault();
              move(0);
            } else if (event.key === "End") {
              event.preventDefault();
              move(tabs.length - 1);
            }
          }}
        >
          {tab.icon ? <span className="tab__icon">{tab.icon}</span> : null}
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={!active}
      tabIndex={0}
      className="tab-panel"
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ dialog */

export interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
}: DialogProps): JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (element) => element.getClientRects().length > 0 || element === document.activeElement,
      );
    const first = focusables()[0] ?? panel;
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem?.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="dialog__header">
          <h2 className="dialog__title" id={titleId}>
            {title}
          </h2>
          <IconButton label="Close dialog" onClick={onClose}>
            <CloseIcon size={16} />
          </IconButton>
        </header>
        {description ? (
          <p className="dialog__description" id={descriptionId}>
            {description}
          </p>
        ) : null}
        <div className="dialog__body">{children}</div>
        {footer ? <footer className="dialog__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- menu */

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

export interface MenuProps {
  label: string;
  items: MenuItem[];
}

export function Menu({ label, items }: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const focusables = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    focusables[0]?.focus();
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && event.target !== triggerRef.current) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  return (
    <div className="menu">
      <button
        type="button"
        ref={triggerRef}
        className="button button--ghost button--sm menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <ChevronDownIcon size={14} />
      </button>
      {open ? (
        <div
          className="menu__list"
          role="menu"
          aria-label={label}
          ref={menuRef}
          onKeyDown={(event) => {
            const focusables = Array.from(
              menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
            );
            const current = focusables.indexOf(document.activeElement as HTMLElement);
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              focusables[(current + 1 + focusables.length) % focusables.length]?.focus();
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              focusables[(current - 1 + focusables.length) % focusables.length]?.focus();
            } else if (event.key === "Home") {
              event.preventDefault();
              focusables[0]?.focus();
            } else if (event.key === "End") {
              event.preventDefault();
              focusables[focusables.length - 1]?.focus();
            }
          }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={cx("menu__item", item.danger && "menu__item--danger")}
              onClick={() => {
                item.onSelect();
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              {item.icon ? <span className="menu__icon">{item.icon}</span> : null}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- callouts */

const TONE_ICONS: Record<Tone, ReactNode> = {
  neutral: <InfoIcon size={16} />,
  primary: <InfoIcon size={16} />,
  success: <CheckIcon size={16} />,
  attention: <WarningIcon size={16} />,
  danger: <WarningIcon size={16} />,
  accent: <InfoIcon size={16} />,
};

export interface CalloutProps {
  tone?: Tone;
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}

export function Callout({
  tone = "neutral",
  title,
  children,
  icon,
  action,
}: CalloutProps): JSX.Element {
  return (
    <div className={cx("callout", `callout--${tone}`)} role={tone === "danger" ? "alert" : "note"}>
      <span className="callout__icon" aria-hidden="true">
        {icon ?? TONE_ICONS[tone]}
      </span>
      <div className="callout__body">
        <p className="callout__title">{title}</p>
        {children ? <div className="callout__text">{children}</div> : null}
      </div>
      {action ? <div className="callout__action">{action}</div> : null}
    </div>
  );
}

export interface NotificationProps {
  tone?: Tone;
  title: string;
  children?: ReactNode;
  onDismiss?: () => void;
}

export function Notification({
  tone = "neutral",
  title,
  children,
  onDismiss,
}: NotificationProps): JSX.Element {
  return (
    <div
      className={cx("notification", `notification--${tone}`)}
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
    >
      <span className="notification__icon" aria-hidden="true">
        {TONE_ICONS[tone]}
      </span>
      <div className="notification__body">
        <p className="notification__title">{title}</p>
        {children ? <div className="notification__text">{children}</div> : null}
      </div>
      {onDismiss ? (
        <IconButton label={`Dismiss: ${title}`} onClick={onDismiss}>
          <CloseIcon size={14} />
        </IconButton>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ badges */

export function Badge({
  tone = "neutral",
  children,
  icon,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <span className={cx("badge", `badge--${tone}`, className)}>
      <span className="badge__icon" aria-hidden="true">
        {icon ?? TONE_ICONS[tone]}
      </span>
      <span>{children}</span>
    </span>
  );
}

export type WorkStatus =
  "pending" | "running" | "paused" | "blocked" | "completed" | "failed" | "interrupted" | "unknown";

const STATUS: Record<WorkStatus, { label: string; tone: Tone; icon: ReactNode }> = {
  pending: { label: "Unstarted", tone: "neutral", icon: <ClockIcon size={14} /> },
  running: { label: "Running", tone: "primary", icon: <PlayIcon size={14} /> },
  paused: { label: "Paused", tone: "attention", icon: <PauseIcon size={14} /> },
  blocked: { label: "Blocked", tone: "danger", icon: <WarningIcon size={14} /> },
  completed: { label: "Completed", tone: "success", icon: <CheckIcon size={14} /> },
  failed: { label: "Failed", tone: "danger", icon: <CloseIcon size={14} /> },
  interrupted: { label: "Interrupted", tone: "attention", icon: <PauseIcon size={14} /> },
  unknown: { label: "Unknown", tone: "neutral", icon: <InfoIcon size={14} /> },
};

export function statusLabel(status: WorkStatus): string {
  return STATUS[status].label;
}

export function StatusBadge({ status }: { status: WorkStatus }): JSX.Element {
  const entry = STATUS[status];
  return (
    <Badge tone={entry.tone} icon={entry.icon} className="status-badge">
      {entry.label}
    </Badge>
  );
}

/* ------------------------------------------------------------------- cards */

export function Card({
  title,
  eyebrow,
  actions,
  children,
  className,
  tone,
}: {
  title?: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  tone?: Tone;
}): JSX.Element {
  return (
    <section className={cx("card", tone && `card--${tone}`, className)}>
      {(title || actions) && (
        <header className="card__header">
          <div>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            {title ? <h2 className="card__title">{title}</h2> : null}
          </div>
          {actions ? <div className="card__actions">{actions}</div> : null}
        </header>
      )}
      <div className="card__body">{children}</div>
    </section>
  );
}

export function Inspector({
  title,
  children,
  actions,
  label,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  label?: string;
}): JSX.Element {
  return (
    <aside className="inspector" aria-label={label ?? title}>
      <header className="inspector__header">
        <h2 className="inspector__title">{title}</h2>
        {actions}
      </header>
      <div className="inspector__body">{children}</div>
    </aside>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty-state">
      {icon ? (
        <span className="empty-state__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <h3 className="empty-state__title">{title}</h3>
      <p className="empty-state__description">{description}</p>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}

export function Skeleton({
  lines = 3,
  label = "Loading",
}: {
  lines?: number;
  label?: string;
}): JSX.Element {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      <span aria-hidden="true">
        {Array.from({ length: lines }, (_, index) => (
          <span key={index} className="skeleton__line" style={{ width: `${92 - index * 9}%` }} />
        ))}
      </span>
    </div>
  );
}

export function ErrorState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="error-state" role="alert">
      <span className="error-state__icon" aria-hidden="true">
        <WarningIcon size={22} />
      </span>
      <div>
        <h3 className="error-state__title">{title}</h3>
        <p className="error-state__message">{message}</p>
        {action ? <div className="error-state__action">{action}</div> : null}
      </div>
    </div>
  );
}

export function SegmentedControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cx("segmented__option", option.value === value && "segmented__option--active")}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cx("switch", checked && "switch--on")}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
      <span className="switch__label">{label}</span>
    </button>
  );
}

export function KeyCap({ children }: { children: ReactNode }): JSX.Element {
  return <kbd className="keycap">{children}</kbd>;
}

export function VisuallyHidden({ children }: { children: ReactNode }): JSX.Element {
  return <span className="visually-hidden">{children}</span>;
}

export function ScreenHeader({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow: string;
  title: string;
  lede: string;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="screen-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="screen-title">{title}</h1>
        <p className="screen-lede">{lede}</p>
      </div>
      {actions ? <div className="screen-header__actions">{actions}</div> : null}
    </header>
  );
}
