import { ReactNode } from 'react'
import { SectionLabel } from '../ui/SectionLabel'

type PageShellProps = {
  title: string
  subtitle: string
  /** Optional chips/badges rendered on the right of the header */
  actions?: ReactNode
  children: ReactNode
}

export function PageShell({ title, subtitle, actions, children }: PageShellProps) {
  return (
    <main className="min-h-screen pl-[88px] pr-6 pt-7 pb-10 lg:pr-10">
      <SectionLabel title={title} subtitle={subtitle} actions={actions} className="mb-6" />
      <div className="flex flex-col gap-5">{children}</div>
    </main>
  )
}
