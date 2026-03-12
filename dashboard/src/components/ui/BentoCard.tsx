import { motion, useReducedMotion } from 'framer-motion'
import { ReactNode } from 'react'

type BentoCardProps = {
  children: ReactNode
  className?: string
  /** Optional extra glow on the border (primary colour) */
  glow?: boolean
  /** Pass-through onClick */
  onClick?: () => void
  /** Extra aria attributes */
  role?: string
  'aria-label'?: string
}

const spring = { type: 'spring' as const, stiffness: 280, damping: 22 }

export function BentoCard({
  children,
  className = '',
  glow = false,
  onClick,
  role,
  'aria-label': ariaLabel,
}: BentoCardProps) {
  const reduce = useReducedMotion()

  const variants = {
    hidden: reduce ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.97 },
    show:   reduce ? { opacity: 1 } : { opacity: 1, y: 0,  scale: 1 },
  }

  return (
    <motion.div
      className={`glass-card p-5 ${glow ? 'glow-ring' : ''} ${onClick ? 'cursor-pointer' : ''} ${className}`}
      variants={variants}
      initial="hidden"
      animate="show"
      transition={spring}
      onClick={onClick}
      role={role}
      aria-label={ariaLabel}
      whileHover={onClick && !reduce ? { scale: 1.015, transition: { ...spring, stiffness: 400 } } : undefined}
      whileTap={onClick && !reduce ? { scale: 0.985 } : undefined}
    >
      {children}
    </motion.div>
  )
}

/** Stagger container — wrap multiple BentoCards to get cascading entrance */
export function BentoGrid({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      className={`bento-grid ${className}`}
      variants={{ hidden: {}, show: { transition: { staggerChildren: reduce ? 0 : 0.055 } } }}
      initial="hidden"
      animate="show"
    >
      {children}
    </motion.div>
  )
}
