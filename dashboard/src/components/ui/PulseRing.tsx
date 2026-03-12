import { motion, useReducedMotion } from 'framer-motion'

type Status = 'online' | 'degraded' | 'offline' | 'checking'

const colorMap: Record<Status, string> = {
  online:   'var(--color-success)',
  degraded: 'var(--color-warn)',
  offline:  'var(--color-danger)',
  checking: 'var(--muted-text)',
}

type PulseRingProps = {
  status?: Status
  size?: number   // dot diameter in px, default 10
  className?: string
}

export function PulseRing({ status = 'checking', size = 10, className = '' }: PulseRingProps) {
  const reduce = useReducedMotion()
  const color = colorMap[status]
  const isLive = status === 'online' && !reduce

  return (
    <span className={`relative inline-flex items-center justify-center ${className}`} style={{ width: size, height: size }}>
      {/* Expanding ring — only on online */}
      {isLive && (
        <motion.span
          className="absolute inset-0 rounded-full"
          style={{ backgroundColor: color, borderRadius: '50%' }}
          animate={{ scale: [1, 2.4, 2.4], opacity: [0.6, 0, 0] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
        />
      )}
      {/* Core dot */}
      <span
        className="relative rounded-full"
        style={{ width: size, height: size, backgroundColor: color }}
      />
    </span>
  )
}
