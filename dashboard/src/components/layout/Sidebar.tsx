import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useState } from 'react'
import { PulseRing } from '../ui/PulseRing'
import { NavId } from '../../types'

type BridgeStatus = 'checking' | 'online' | 'degraded' | 'offline'

type SidebarProps = {
  activeNav: NavId
  onSelect: (id: NavId) => void
  disabledNavs?: Record<NavId, boolean>
  bridgeStatus?: BridgeStatus
}

const navItems: { id: NavId; label: string; icon: JSX.Element }[] = [
  {
    id: 'launcher',
    label: 'Launcher',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16.5 16.5l4 4" strokeWidth="1.8" />
      </svg>
    ),
  },
  {
    id: 'results',
    label: 'Results',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <rect x="3" y="14" width="4" height="7" rx="1" />
        <rect x="10" y="9"  width="4" height="12" rx="1" />
        <rect x="17" y="4"  width="4" height="17" rx="1" />
      </svg>
    ),
  },
  {
    id: 'audit',
    label: 'Audit',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
        <rect x="9" y="3" width="6" height="4" rx="1.5" />
        <path d="M9 12h6M9 16h4" />
      </svg>
    ),
  },
  {
    id: 'explorer',
    label: 'Explorer',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3"  y="3"  width="8" height="8"  rx="2" />
        <rect x="13" y="3"  width="8" height="8"  rx="2" />
        <rect x="3"  y="13" width="8" height="8"  rx="2" />
        <rect x="13" y="13" width="8" height="8"  rx="2" />
      </svg>
    ),
  },
  {
    id: 'catalog',
    label: 'Catalog',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M4 6.5C4 5.1 7.6 4 12 4s8 1.1 8 2.5S16.4 9 12 9 4 7.9 4 6.5z" />
        <path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" />
        <path d="M4 17.5C4 18.9 7.6 20 12 20s8-1.1 8-2.5V6.5" />
        <path d="M4 6.5v11" />
      </svg>
    ),
  },
  {
    id: 'annotations',
    label: 'Annotations',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
        <circle cx="7" cy="7" r="1" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: 'consistency',
    label: 'Consistency',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <rect x="3"  y="4" width="8"  height="16" rx="1.5" />
        <rect x="13" y="4" width="8"  height="16" rx="1.5" />
        <path d="M9 9h6M9 15h6" />
      </svg>
    ),
  },
  {
    id: 'database',
    label: 'Database',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <ellipse cx="12" cy="6" rx="7" ry="3" />
        <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
        <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
      </svg>
    ),
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
]

function NavButton({
  item,
  isActive,
  isDisabled,
  onSelect,
}: {
  item: typeof navItems[number]
  isActive: boolean
  isDisabled: boolean
  onSelect: (id: NavId) => void
}) {
  const [hovered, setHovered] = useState(false)
  const reduce = useReducedMotion()

  return (
    <div className="relative flex items-center" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {/* Active accent bar */}
      {isActive && (
        <motion.span
          layoutId="nav-active-bar"
          className="absolute -left-3 h-6 w-[3px] rounded-full"
          style={{ background: 'var(--color-primary)', boxShadow: 'var(--glow-sm)' }}
          transition={{ type: 'spring', stiffness: 380, damping: 28 }}
        />
      )}

      <button
        className={`focusable flex h-12 w-12 items-center justify-center rounded-xl border transition-colors duration-150 ${
          isActive
            ? 'border-[var(--glass-border)] bg-[rgba(0,230,255,0.08)] text-[var(--color-primary)]'
            : isDisabled
              ? 'cursor-not-allowed border-transparent bg-transparent text-[var(--muted-text)] opacity-30'
              : 'border-transparent bg-transparent text-[var(--muted-text)] hover:border-[var(--glass-border)] hover:bg-[rgba(255,255,255,0.05)] hover:text-[var(--color-text)]'
        }`}
        aria-label={item.label}
        aria-current={isActive ? 'page' : undefined}
        aria-disabled={isDisabled ? 'true' : undefined}
        disabled={isDisabled}
        onClick={() => onSelect(item.id)}
        title={isDisabled ? `${item.label} unlocks when the cluster bridge is ready.` : item.label}
      >
        {item.icon}
      </button>

      {/* Floating label tooltip */}
      <AnimatePresence>
        {hovered && !isDisabled && (
          <motion.div
            className="pointer-events-none absolute left-[56px] z-50 whitespace-nowrap rounded-lg border px-3 py-1.5 text-[12px] font-medium"
            style={{
              background: 'var(--glass-bg)',
              borderColor: 'var(--glass-border)',
              color: 'var(--color-text)',
              backdropFilter: 'blur(12px)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            }}
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: -6 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, x: 0  }}
            exit={reduce   ? { opacity: 0 } : { opacity: 0, x: -4  }}
            transition={{ duration: 0.14 }}
          >
            {item.label}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function Sidebar({
  activeNav,
  onSelect,
  disabledNavs,
  bridgeStatus = 'checking',
}: SidebarProps) {
  return (
    <aside
      className="fixed left-0 top-0 flex h-screen w-[72px] flex-col items-center gap-5 py-5"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(14px) saturate(160%)',
        WebkitBackdropFilter: 'blur(14px) saturate(160%)',
        borderRight: '1px solid var(--glass-border)',
        boxShadow: '2px 0 24px rgba(0,0,0,0.35)',
        zIndex: 50,
      }}
    >
      {/* Logo chip + bridge pulse */}
      <div className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] text-[11px] font-bold tracking-widest text-[var(--color-primary)]">
        PR
        <span className="absolute -right-1 -top-1">
          <PulseRing status={bridgeStatus} size={9} />
        </span>
      </div>

      {/* Divider */}
      <div className="h-px w-8 bg-[var(--glass-border)]" />

      {/* Nav items */}
      <nav className="flex flex-1 flex-col items-center gap-1.5">
        {navItems.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            isActive={activeNav === item.id}
            isDisabled={!!(disabledNavs?.[item.id])}
            onSelect={onSelect}
          />
        ))}
      </nav>

      <div className="mono text-[9px] text-[var(--muted-text)] opacity-60">v0.9</div>
    </aside>
  )
}
