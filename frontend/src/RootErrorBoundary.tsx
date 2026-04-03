import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

export class RootErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('App crashed:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            maxWidth: 640,
            margin: '48px auto',
            fontFamily: 'system-ui, sans-serif',
            background: '#f2f5fa',
            color: '#1e293b',
            minHeight: '100vh',
          }}
        >
          <h1 style={{ fontSize: 20, marginBottom: 12, color: '#1e293b' }}>
            Something went wrong
          </h1>
          <p style={{ color: '#64748b', marginBottom: 16 }}>
            The UI hit an error while loading. You can refresh the page. If this
            keeps happening, check the browser console (Developer Tools) for
            details.
          </p>
          <pre
            style={{
              background: '#fafbfc',
              border: '1px solid #d1d7e0',
              color: '#334155',
              padding: 12,
              borderRadius: 8,
              overflow: 'auto',
              fontSize: 13,
            }}
          >
            {this.state.error.message}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}
