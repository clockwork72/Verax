import { ReactNode } from 'react'

type SectionLabelProps = {
  title: string
  subtitle?: string
  /** Slot rendered on the right side (status chips, action buttons, etc.) */
  actions?: ReactNode
  className?: string
}

export function SectionLabel({ title, subtitle, actions, className = '' }: SectionLabelProps) {
  return (
    <div className={`flex items-start justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        <h1 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-[var(--color-primary)]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-0.5 text-[13px] text-[var(--muted-text)] leading-snug">
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  )
}
