import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

/** Shows any startup error on screen instead of leaving a blank window. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  override render() {
    if (this.state.error) {
      return (
        <pre style={{ padding: 24, color: '#ff8a8a', whiteSpace: 'pre-wrap' }}>
          Something went wrong:{'\n\n'}
          {this.state.error.stack ?? this.state.error.message}
        </pre>
      )
    }
    return this.props.children
  }
}

const root = document.getElementById('root') as HTMLElement
if (!window.pas) {
  root.innerHTML =
    '<pre style="padding:24px;color:#ff8a8a;white-space:pre-wrap">The preload bridge (window.pas) is missing, so the editor cannot talk to the app.\nCheck the terminal for a [preload error] line.</pre>'
} else {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  )
}
