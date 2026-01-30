import { useEffect, useMemo, useState } from 'react'
import './App.css'

const ENV_GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID

const loadGoogleScript = () =>
  new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve()
      return
    }

    const existing = document.querySelector(
      'script[src="https://accounts.google.com/gsi/client"]',
    )
    if (existing) {
      existing.addEventListener('load', resolve)
      existing.addEventListener('error', reject)
      return
    }

    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = resolve
    script.onerror = () => reject(new Error('Failed to load Google auth library'))
    document.head.appendChild(script)
  })

const formatExpiry = (value) => {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString()
}

function App() {
  const [googleClientId, setGoogleClientId] = useState(ENV_GOOGLE_CLIENT_ID || '')
  const [authConfigured, setAuthConfigured] = useState(Boolean(ENV_GOOGLE_CLIENT_ID))
  const [authUser, setAuthUser] = useState(null)
  const [authExpiry, setAuthExpiry] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [error, setError] = useState('')
  const [secretMessage, setSecretMessage] = useState('')

  const statusLabel = useMemo(() => {
    if (authLoading) return 'Checking session'
    if (authUser) return 'Signed in'
    return 'Signed out'
  }, [authLoading, authUser])

  useEffect(() => {
    let cancelled = false

    const initAuth = async () => {
      try {
        let configData = null
        const configResponse = await fetch('/api/auth/config', { credentials: 'include' })
        if (configResponse.ok) {
          configData = await configResponse.json()
          if (typeof configData?.googleAuthConfigured === 'boolean') {
            setAuthConfigured(configData.googleAuthConfigured)
          } else if (configData?.googleClientId) {
            setAuthConfigured(true)
          }
          if (configData?.googleClientId) {
            setGoogleClientId(configData.googleClientId)
          }
        }

        const resolvedClientId = (
          configData?.googleClientId || googleClientId || ENV_GOOGLE_CLIENT_ID || ''
        ).trim()
        if (resolvedClientId) {
          await loadGoogleScript()
        }
      } catch (err) {
        console.error('Failed to load Google auth script:', err)
      }

      try {
        const response = await fetch('/api/auth/me', { credentials: 'include' })
        if (!response.ok) {
          throw new Error('Unable to check auth state')
        }
        const data = await response.json()
        if (!cancelled) {
          if (data?.authenticated && data?.user) {
            setAuthUser(data.user)
            setAuthExpiry(data.expiresAt || null)
          } else {
            setAuthUser(null)
            setAuthExpiry(null)
          }
        }
      } catch (err) {
        console.error('Auth check failed:', err)
        if (!cancelled) {
          setAuthUser(null)
          setAuthExpiry(null)
        }
      } finally {
        if (!cancelled) {
          setAuthLoading(false)
        }
      }
    }

    initAuth()
    return () => {
      cancelled = true
    }
  }, [])

  const handleGoogleCredential = async (credential) => {
    try {
      const response = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ credential }),
      })
      if (!response.ok) {
        throw new Error('Sign-in failed')
      }
      const data = await response.json()
      setAuthUser(data?.user || null)
      setAuthExpiry(null)
      setError('')
    } catch (err) {
      console.error('Google sign-in failed:', err)
      setError('Login failed. Please try again.')
    }
  }

  const startGoogleSignIn = async () => {
    const clientId = (googleClientId || ENV_GOOGLE_CLIENT_ID || '').trim()
    if (!clientId) {
      setError('Google sign-in is not configured.')
      return
    }
    try {
      await loadGoogleScript()
      if (!window.google?.accounts?.id) {
        throw new Error('Google auth unavailable')
      }
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (response) => {
          if (response?.credential) {
            handleGoogleCredential(response.credential)
          }
        },
        ux_mode: 'popup',
        use_fedcm_for_prompt: false,
        auto_select: false,
      })
      window.google.accounts.id.prompt()
    } catch (err) {
      console.error('Google auth init failed:', err)
      setError('Google sign-in is unavailable right now.')
    }
  }

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } catch {
      // ignore
    } finally {
      setAuthUser(null)
      setAuthExpiry(null)
    }
  }

  const fetchSecret = async () => {
    setSecretMessage('')
    try {
      const response = await fetch('/api/secret', { credentials: 'include' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || 'Request failed')
      }
      setSecretMessage(data?.message || 'Success.')
    } catch (err) {
      setSecretMessage(err instanceof Error ? err.message : 'Unable to reach API.')
    }
  }

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <p className="eyebrow">Login template</p>
          <h1>Google Auth Starter</h1>
          <p className="sub">
            Minimal React + Express template with Google Sign-In and HTTP-only session cookies.
          </p>
        </div>
        <div className="status">
          <span className={`dot ${authUser ? 'online' : 'offline'}`} />
          {statusLabel}
        </div>
      </header>

      {error ? <div className="card error">{error}</div> : null}

      <div className="grid">
        <section className="card">
          <h2>Session</h2>
          {authLoading ? (
            <p className="muted">Checking your session...</p>
          ) : authUser ? (
            <div className="user">
              {authUser.picture ? (
                <img className="avatar" src={authUser.picture} alt="Profile" />
              ) : (
                <div className="avatar placeholder" />
              )}
              <div>
                <p className="name">{authUser.name || 'Signed-in user'}</p>
                <p className="muted">{authUser.email || authUser.sub}</p>
                {authExpiry ? <p className="muted">Expires: {formatExpiry(authExpiry)}</p> : null}
              </div>
            </div>
          ) : (
            <p className="muted">Sign in to test the authenticated endpoints.</p>
          )}
          <div className="actions">
            {authUser ? (
              <button className="ghost" type="button" onClick={logout}>
                Sign out
              </button>
            ) : (
              <button type="button" onClick={startGoogleSignIn} disabled={!authConfigured}>
                Sign in with Google
              </button>
            )}
          </div>
          {!authConfigured ? (
            <p className="hint">Set GOOGLE_CLIENT_ID and AUTH_SESSION_SECRET to enable login.</p>
          ) : null}
        </section>

        <section className="card">
          <h2>Protected API example</h2>
          <p className="muted">
            Calls <code>/api/secret</code> with credentials. Use this pattern for any authenticated
            route.
          </p>
          <div className="actions">
            <button className="secondary" type="button" onClick={fetchSecret} disabled={authLoading}>
              Call protected endpoint
            </button>
          </div>
          {secretMessage ? <p className="muted">{secretMessage}</p> : null}
        </section>

        <section className="card">
          <h2>Setup checklist</h2>
          <ul>
            <li>Create a Google OAuth client (Web) and copy the Client ID.</li>
            <li>Set <code>GOOGLE_CLIENT_ID</code> and <code>AUTH_SESSION_SECRET</code> in <code>.env</code>.</li>
            <li>Optional: set <code>CORS_ORIGINS</code> when hosting the client elsewhere.</li>
            <li>Run <code>npm run dev</code> (server) and <code>npm run client:dev</code> (client).</li>
          </ul>
        </section>
      </div>
    </div>
  )
}

export default App
