import { NavId } from '../../types'

type SidebarProps = {
  activeNav: NavId
  onSelect: (id: NavId) => void
}

const navItems: { id: NavId; label: string; icon: JSX.Element }[] = [
  {
    id: 'launcher',
    label: 'Search',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="11" cy="11" r="6" />
        <path d="M16 16l4 4" />
      </svg>
    ),
  },
  {
    id: 'results',
    label: 'Results',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M5 6h14" />
        <path d="M5 12h14" />
        <path d="M5 18h10" />
      </svg>
    ),
  },
  {
    id: 'audit',
    label: 'Audit',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M4 6h16" />
        <path d="M4 12h10" />
        <path d="M4 18h7" />
        <circle cx="17.5" cy="17.5" r="3.5" />
        <path d="M20.2 20.2l1.8 1.8" />
      </svg>
    ),
  },
  {
    id: 'explorer',
    label: 'Explorer',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="4" y="4" width="7" height="7" rx="1.5" />
        <rect x="13" y="4" width="7" height="7" rx="1.5" />
        <rect x="4" y="13" width="7" height="7" rx="1.5" />
        <rect x="13" y="13" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    id: 'annotations',
    label: 'Annotations',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
        <line x1="7" y1="7" x2="7.01" y2="7" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'consistency',
    label: 'Consistency',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="5" width="8" height="14" rx="1.5" />
        <rect x="13" y="5" width="8" height="14" rx="1.5" />
        <path d="M9 9h6" />
        <path d="M9 15h6" />
      </svg>
    ),
  },
  {
    id: 'database',
    label: 'Database',
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
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
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
        <path d="M19.5 12a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.5-2.4 1a7.8 7.8 0 0 0-2.2-1.3l-.4-2.6H9.6l-.4 2.6a7.8 7.8 0 0 0-2.2 1.3l-2.4-1-2 3.5 2 1.6a7.4 7.4 0 0 0-.1 1.3 7.4 7.4 0 0 0 .1 1.3l-2 1.6 2 3.5 2.4-1a7.8 7.8 0 0 0 2.2 1.3l.4 2.6h4.8l.4-2.6a7.8 7.8 0 0 0 2.2-1.3l2.4 1 2-3.5-2-1.6c.1-.4.1-.9.1-1.3Z" />
      </svg>
    ),
  },
]

export function Sidebar({ activeNav, onSelect }: SidebarProps) {
  return (
    <aside className="rail fixed left-0 top-0 flex h-screen w-[72px] flex-col items-center gap-4 py-6">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--border-soft)]" />
      <nav className="flex flex-1 flex-col items-center gap-3">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`rail-btn focusable ${activeNav === item.id ? 'active' : ''}`}
            aria-label={item.label}
            onClick={() => onSelect(item.id)}
          >
            {item.icon}
          </button>
        ))}
      </nav>
      <div className="text-[10px] text-[var(--muted-text)]">v0.9</div>
    </aside>
  )
}
