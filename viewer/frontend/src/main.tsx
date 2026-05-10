import React from 'react'
import ReactDOM from 'react-dom/client'
import App, { RegenProvider } from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RegenProvider>
      <App />
    </RegenProvider>
  </React.StrictMode>,
)
