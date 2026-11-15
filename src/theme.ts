import { Hct, SchemeTonalSpot, MaterialDynamicColors as M, argbFromHex, hexFromArgb } from '@material/material-color-utilities'

const ROLES = [
  'primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer',
  'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer',
  'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer',
  'error', 'onError', 'errorContainer', 'onErrorContainer',
  'surface', 'onSurface', 'onSurfaceVariant', 'surfaceDim', 'surfaceBright',
  'surfaceContainerLowest', 'surfaceContainerLow', 'surfaceContainer', 'surfaceContainerHigh', 'surfaceContainerHighest',
  'outline', 'outlineVariant', 'inverseSurface', 'inverseOnSurface', 'inversePrimary',
] as const

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

export function applyTheme(seed = '#3F6DF2') {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(seed)), dark, 0)
  const root = document.documentElement.style
  for (const r of ROLES) {
    const dc = (M as any)[r]
    if (dc) root.setProperty('--md-' + kebab(r), hexFromArgb(dc.getArgb(scheme)))
  }
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', hexFromArgb((M as any).surfaceContainer.getArgb(scheme)))
}
