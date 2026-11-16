/**
 * Shared icon pieces.
 *
 * Icon draws a Material Symbols ligature (the icon font comes from Google Fonts
 * and is precached by the service worker, so it draws offline too).
 *
 * QuickShareIcon is the Quick Share mark redrawn for Material: the two curved
 * exchange arrows of the Quick Share logo (from its published SVG) inside the
 * ring, sized for 24/48dp and drawn with `currentColor` so it takes the tone of
 * whatever holds it. It replaces the generic share icon everywhere the app
 * offers to send something.
 *
 * GroqIcon is the Groq「g」mark (the monochrome glyph from Groq's published
 * icon set, also served as @lobehub/icons-static-svg/icons/groq.svg), redrawn
 * for Material 3: a 24×24 grid whose 2dp margins match Material Symbols, a
 * single `currentColor` path with the same even-odd fill as the original, no
 * gradients or wordmark, so it sits at the same optical weight as the icons
 * next to it in the dock, the app drawer and the Quick AI window. Amber is
 * never baked in: the dock's tonal container decides the colour, exactly as
 * Material 3 asks.
 */
export const Icon = ({ n, fill, className = '' }: { n: string; fill?: boolean; className?: string }) =>
  <span className={'ms ' + className} style={fill ? { fontVariationSettings: "'FILL' 1" } : undefined}>{n}</span>

/**
 * Quick Share mark, redrawn for Material: the two curved exchange arrows of the
 * Quick Share logo (fetched from its published SVG) inside the ring, sized for
 * 24/48dp, drawn with `currentColor` so it takes the tone of whatever holds it.
 * Replaces the generic share icon everywhere the app offers to send something.
 */
export const QuickShareIcon = ({ size = 24, className = '', ring = true }: { size?: number; className?: string; ring?: boolean }) => (
  <svg className={'qsicon ' + className} viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
    {ring && <circle cx="12" cy="12" r="10.3" fill="none" stroke="currentColor" strokeOpacity=".3" strokeWidth="1.5" />}
    <g transform="translate(1.1775 1.1775) scale(0.0975)">
      <path d="M183.827 110.596c-3.629 0-6.738-2.738-7.119-6.405-3.466-33.6-31.716-58.936-65.706-58.936-27.54 0-51.718 16.758-61.499 41.657h43.47l-3.517-3.502a6.312 6.312 0 0 1 0-8.956 6.388 6.388 0 0 1 9.004 0l15.17 15.098a6.314 6.314 0 0 1 0 8.961l-15.17 15.098a6.384 6.384 0 0 1-8.999 0 6.315 6.315 0 0 1 0-8.961l3.493-3.475H40.305c-2.195 0-4.589-1.168-5.95-2.885-1.363-1.725-1.93-4.34-1.406-6.467C41.801 56.011 73.9 31 111.002 31c41.361 0 75.736 30.843 79.96 71.737.404 3.914-2.46 7.418-6.396 7.82a8.026 8.026 0 0 1-.739.039Z" />
      <path d="M37.437 111.354c3.983-.356 7.45 2.46 7.854 6.374.12 1.199.276 2.39.462 3.565 5.071 32.131 32.514 55.444 65.249 55.444 27.551 0 51.737-16.761 61.51-41.683h-43.509l3.545 3.528a6.316 6.316 0 0 1 0 8.961 6.385 6.385 0 0 1-8.999 0l-15.174-15.101a6.316 6.316 0 0 1 0-8.961l15.171-15.099a6.39 6.39 0 0 1 9.004 0 6.313 6.313 0 0 1 0 8.957l-3.468 3.452h52.628c2.195 0 4.593 1.168 5.949 2.885 1.364 1.725 1.931 4.324 1.407 6.458C180.225 165.97 148.124 191 111.002 191c-39.835 0-73.226-28.387-79.401-67.494a83.856 83.856 0 0 1-.564-4.34c-.4-3.913 2.468-7.41 6.4-7.812Z" />
    </g>
  </svg>
)

/**
 * Groq「g」— the Quick AI app mark. 24×24, `currentColor`, even-odd fill: the
 * glyph itself carries no colour, so the Material 3 tonal container around it
 * (secondary container in the dock and drawer, primary container in the
 * window header) decides its tone, the same way every other M3 app icon does.
 */
export const GroqIcon = ({ size = 24, className = '' }: { size?: number; className?: string }) => (
  <svg className={'groqicon ' + className} viewBox="0 0 24 24" width={size} height={size}
    fill="currentColor" fillRule="evenodd" aria-hidden="true" focusable="false">
    <path d="M12.036 2c-3.853-.035-7 3-7.036 6.781-.035 3.782 3.055 6.872 6.908 6.907h2.42v-2.566h-2.292c-2.407.028-4.38-1.866-4.408-4.23-.029-2.362 1.901-4.298 4.308-4.326h.1c2.407 0 4.358 1.915 4.365 4.278v6.305c0 2.342-1.944 4.25-4.323 4.279a4.375 4.375 0 0 1-3.033-1.252l-1.851 1.818A7 7 0 0 0 12.029 22h.092c3.803-.056 6.858-3.083 6.879-6.816v-6.5C18.907 4.963 15.817 2 12.036 2Z" />
  </svg>
)
