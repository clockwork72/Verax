import { useEffect, useRef, useState } from 'react'

type AnimatedCounterProps = {
  value: number
  /** Duration of the count-up in ms, default 900 */
  duration?: number
  /** Decimal places, default 0 */
  decimals?: number
  /** Suffix appended after the number */
  suffix?: string
  className?: string
}

function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t)
}

export function AnimatedCounter({
  value,
  duration = 900,
  decimals = 0,
  suffix = '',
  className = '',
}: AnimatedCounterProps) {
  const [display, setDisplay] = useState(0)
  const startRef = useRef<number | null>(null)
  const rafRef   = useRef<number | null>(null)
  const prevRef  = useRef(0)

  useEffect(() => {
    // Respect prefers-reduced-motion at runtime (matchMedia absent in test envs)
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(value)
      return
    }

    const from = prevRef.current
    const to   = value

    const animate = (ts: number) => {
      if (startRef.current === null) startRef.current = ts
      const elapsed = ts - startRef.current
      const progress = Math.min(elapsed / duration, 1)
      const eased = easeOutExpo(progress)
      setDisplay(from + (to - from) * eased)
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate)
      } else {
        prevRef.current = to
        startRef.current = null
      }
    }

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    startRef.current = null
    rafRef.current = requestAnimationFrame(animate)

    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current) }
  }, [value, duration])

  const formatted = display.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })

  return (
    <span className={className}>
      {formatted}{suffix}
    </span>
  )
}
