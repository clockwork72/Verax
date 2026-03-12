type PillVariant = 'ok' | 'warn' | 'error' | 'pending' | 'idle' | 'running' | 'stopped'

const pillConfig: Record<PillVariant, { dot: string; bg: string; text: string; label: string }> = {
  ok:      { dot: 'bg-[var(--color-success)]', bg: 'bg-[rgba(57,255,20,0.08)]  border-[rgba(57,255,20,0.25)]',   text: 'text-[var(--color-success)]', label: 'ok'      },
  warn:    { dot: 'bg-[var(--color-warn)]',    bg: 'bg-[rgba(255,209,102,0.08)] border-[rgba(255,209,102,0.25)]', text: 'text-[var(--color-warn)]',    label: 'warn'    },
  error:   { dot: 'bg-[var(--color-danger)]',  bg: 'bg-[rgba(255,45,149,0.08)]  border-[rgba(255,45,149,0.25)]',  text: 'text-[var(--color-danger)]',  label: 'error'   },
  pending: { dot: 'bg-[var(--muted-text)]',    bg: 'bg-[rgba(255,255,255,0.04)] border-[var(--border-soft)]',     text: 'text-[var(--muted-text)]',    label: 'pending' },
  idle:    { dot: 'bg-[var(--muted-text)]',    bg: 'bg-[rgba(255,255,255,0.04)] border-[var(--border-soft)]',     text: 'text-[var(--muted-text)]',    label: 'idle'    },
  running: { dot: 'bg-[var(--color-primary)]', bg: 'bg-[rgba(0,230,255,0.07)]   border-[rgba(0,230,255,0.22)]',   text: 'text-[var(--color-primary)]', label: 'running' },
  stopped: { dot: 'bg-[var(--muted-text)]',    bg: 'bg-[rgba(255,255,255,0.04)] border-[var(--border-soft)]',     text: 'text-[var(--muted-text)]',    label: 'stopped' },
}

type StatusPillProps = {
  variant: PillVariant
  label?: string
  pulse?: boolean
  className?: string
}

export function StatusPill({ variant, label, pulse = false, className = '' }: StatusPillProps) {
  const cfg = pillConfig[variant]
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide ${cfg.bg} ${cfg.text} ${className}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${cfg.dot} ${pulse ? 'animate-pulse' : ''}`}
      />
      {label ?? cfg.label}
    </span>
  )
}
