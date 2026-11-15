import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { applyTheme } from './theme'

applyTheme(localStorage.getItem('ts.seed') || undefined)
createRoot(document.getElementById('root')!).render(<App />)
