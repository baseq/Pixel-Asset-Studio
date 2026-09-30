import { useEffect, useState } from 'react'

export type ThemePref = 'system' | 'dark' | 'light'
const KEY = 'pas.theme'

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'dark' || v === 'light' || v === 'system') return v
  } catch {
    /* storage unavailable */
  }
  return 'system'
}

function apply(pref: ThemePref): void {
  const root = document.documentElement
  if (pref === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', pref)
}

/** Theme preference: 'system' follows the OS, 'dark'/'light' force one. Persisted per machine. */
export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(read)
  useEffect(() => {
    apply(pref)
    try {
      localStorage.setItem(KEY, pref)
    } catch {
      /* ignore */
    }
  }, [pref])
  return [pref, setPref]
}
