import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { applyTheme } from './theme'

applyTheme(localStorage.getItem('ts.seed') || undefined)
// Replace the inline boot splash (index.html) with the app itself.
const rootEl = document.getElementById('root')!
rootEl.replaceChildren()
createRoot(rootEl).render(<App />)

// PWA: the service worker provides the offline shell (cache-first, so a
// Chromebook start paints without waiting for the network), the share target
// that receives files/text from other apps, and desktop notifications.
// Registering right away — not on `load` — lets the install start while the
// first screen is still being drawn, and a periodic update() picks up a new
// deploy in the background.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    window.setInterval(() => { reg.update().catch(() => {}) }, 30 * 60 * 1000)
  }).catch(() => {})
}
