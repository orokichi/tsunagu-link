import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { applyTheme } from './theme'

applyTheme(localStorage.getItem('ts.seed') || undefined)
createRoot(document.getElementById('root')!).render(<App />)

// PWA: the service worker shows desktop notifications (with inline reply) and
// provides the offline shell. Its cache is network-first, so deploys are never
// masked by a stale cached version.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}
