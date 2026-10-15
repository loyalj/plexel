/**
 * Callbacks that keep their identity across renders, so a memoised
 * component given them isn't drawn again just because its parent was, but
 * that always run the latest version of each function (with whatever the
 * parent's last render closed over).
 */
import { useLayoutEffect, useMemo, useRef } from 'react'

type Fns = Record<string, (...args: never[]) => unknown>

export function useStable<T extends Fns>(fns: T): T {
  const latest = useRef(fns)
  useLayoutEffect(() => {
    latest.current = fns
  })
  // The keys are fixed for a call site, so the wrappers are made once.
  return useMemo(() => {
    const out: Record<string, (...args: never[]) => unknown> = {}
    for (const k of Object.keys(fns)) out[k] = (...args: never[]) => latest.current[k](...args)
    return out as T
    // Made once: they read `latest`.
  }, [])
}
