import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const ENV_GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID
const PAYPAL_SDK_URL = 'https://www.paypal.com/sdk/js'

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

const buildPayPalScriptSrc = ({ clientId, currency }) => {
  const params = new URLSearchParams({
    'client-id': clientId,
    components: 'buttons',
    intent: 'subscription',
    vault: 'true',
    currency: currency || 'USD',
    'enable-funding': 'card',
  })
  return `${PAYPAL_SDK_URL}?${params.toString()}`
}

const loadPayPalScript = ({ clientId, currency }) =>
  new Promise((resolve, reject) => {
    if (!clientId) {
      reject(new Error('Missing PayPal client ID'))
      return
    }

    if (window.paypal?.Buttons) {
      resolve()
      return
    }

    const existing = document.querySelector('script[data-paypal-sdk="true"]')
    const src = buildPayPalScriptSrc({ clientId, currency })
    if (existing) {
      if (existing.getAttribute('src') !== src) {
        existing.remove()
      } else {
        existing.addEventListener('load', resolve)
        existing.addEventListener('error', reject)
        return
      }
    }

    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.defer = true
    script.dataset.paypalSdk = 'true'
    script.onload = resolve
    script.onerror = () => reject(new Error('Failed to load PayPal SDK'))
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
  const [page, setPage] = useState('home')
  const [subscriptionConfig, setSubscriptionConfig] = useState(null)
  const [subscriptionLoading, setSubscriptionLoading] = useState(true)
  const [subscriptionError, setSubscriptionError] = useState('')
  const [subscriptionMessage, setSubscriptionMessage] = useState('')
  const [chargeConsent, setChargeConsent] = useState(false)
  const [subscriptionPlans, setSubscriptionPlans] = useState([])
  const [subscriptionPlansLoading, setSubscriptionPlansLoading] = useState(true)
  const [subscriptionPlansError, setSubscriptionPlansError] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [adminLoading, setAdminLoading] = useState(false)
  const [adminError, setAdminError] = useState('')
  const [adminPlans, setAdminPlans] = useState([])
  const [adminPlansLoading, setAdminPlansLoading] = useState(false)
  const [planForm, setPlanForm] = useState({
    productName: '',
    productDescription: '',
    planName: '',
    planDescription: '',
    price: '',
    currency: 'USD',
    intervalUnit: 'MONTH',
    intervalCount: 1,
  })
  const planButtonRefs = useRef(new Map())

  const paypalPlanBaseUrl =
    subscriptionConfig?.paypalEnv === 'live'
      ? 'https://www.paypal.com/billing/plans/'
      : 'https://www.sandbox.paypal.com/billing/plans/'

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

  useEffect(() => {
    let cancelled = false
    const loadPlans = async () => {
      setSubscriptionPlansLoading(true)
      setSubscriptionPlansError('')
      try {
        const response = await fetch('/api/subscription/plans', { credentials: 'include' })
        if (!response.ok) {
          throw new Error('Unable to load subscription plans')
        }
        const data = await response.json()
        if (!cancelled) {
          setSubscriptionPlans(Array.isArray(data?.plans) ? data.plans : [])
        }
      } catch (err) {
        console.error('Subscription plans load failed:', err)
        if (!cancelled) {
          setSubscriptionPlans([])
          setSubscriptionPlansError(
            err instanceof Error ? err.message : 'Unable to load subscription plans.',
          )
        }
      } finally {
        if (!cancelled) {
          setSubscriptionPlansLoading(false)
        }
      }
    }
    loadPlans()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const syncPage = () => {
      const hash = window.location.hash.replace('#', '')
      if (hash === 'subscription') {
        setPage('subscription')
      } else if (hash === 'admin') {
        setPage('admin')
      } else {
        setPage('home')
      }
    }
    syncPage()
    window.addEventListener('hashchange', syncPage)
    return () => {
      window.removeEventListener('hashchange', syncPage)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadSubscriptionConfig = async () => {
      try {
        const response = await fetch('/api/subscription/config', { credentials: 'include' })
        if (!response.ok) {
          throw new Error('Unable to load subscription config')
        }
        const data = await response.json()
        if (!cancelled) {
          setSubscriptionConfig(data)
        }
      } catch (err) {
        console.error('Subscription config load failed:', err)
        if (!cancelled) {
          setSubscriptionConfig(null)
        }
      } finally {
        if (!cancelled) {
          setSubscriptionLoading(false)
        }
      }
    }
    loadSubscriptionConfig()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadAdminConfig = async () => {
      if (!authUser) {
        setIsAdmin(false)
        setAdminPlans([])
        return
      }
      setAdminLoading(true)
      try {
        const response = await fetch('/api/admin/config', { credentials: 'include' })
        if (!response.ok) {
          throw new Error('Unable to load admin config')
        }
        const data = await response.json()
        if (!cancelled) {
          setIsAdmin(Boolean(data?.isAdmin))
          if (!data?.isAdmin) {
            setAdminPlans([])
          }
        }
      } catch (err) {
        console.error('Admin config load failed:', err)
        if (!cancelled) {
          setIsAdmin(false)
          setAdminPlans([])
        }
      } finally {
        if (!cancelled) {
          setAdminLoading(false)
        }
      }
    }
    loadAdminConfig()
    return () => {
      cancelled = true
    }
  }, [authUser])

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    const loadPlans = async () => {
      setAdminPlansLoading(true)
      try {
        const response = await fetch('/api/admin/plans', { credentials: 'include' })
        if (!response.ok) {
          throw new Error('Unable to load plans')
        }
        const data = await response.json()
        if (!cancelled) {
          setAdminPlans(Array.isArray(data?.plans) ? data.plans : [])
        }
      } catch (err) {
        console.error('Plan load failed:', err)
        if (!cancelled) {
          setAdminPlans([])
        }
      } finally {
        if (!cancelled) {
          setAdminPlansLoading(false)
        }
      }
    }
    loadPlans()
    return () => {
      cancelled = true
    }
  }, [isAdmin])

  useEffect(() => {
    const clearContainers = () => {
      planButtonRefs.current.forEach((node) => {
        if (node) {
          node.innerHTML = ''
        }
      })
    }

    if (page !== 'subscription') {
      clearContainers()
      return
    }
    if (!subscriptionConfig?.paypalConfigured) {
      clearContainers()
      return
    }
    if (!authUser) {
      clearContainers()
      return
    }
    if (subscriptionConfig?.paypalEnv === 'live' && !chargeConsent) {
      clearContainers()
      return
    }
    if (!subscriptionPlans.length) {
      clearContainers()
      return
    }

    const currencySet = new Set(
      subscriptionPlans
        .map((plan) => (plan.currency_code || 'USD').toUpperCase())
        .filter(Boolean),
    )
    if (currencySet.size > 1) {
      setSubscriptionError('Plans use multiple currencies. Load one currency at a time.')
      clearContainers()
      return
    }

    let cancelled = false
    const activeButtons = new Map()

    const renderButtons = async () => {
      setSubscriptionError('')
      const currency =
        currencySet.values().next().value || subscriptionConfig?.subscription?.currency || 'USD'
      await loadPayPalScript({
        clientId: subscriptionConfig?.paypalClientId,
        currency,
      })
      if (cancelled) return
      if (!window.paypal?.Buttons) {
        throw new Error('PayPal Buttons unavailable')
      }

      subscriptionPlans.forEach((plan) => {
        const planId = plan.paypal_plan_id
        const container = planButtonRefs.current.get(planId)
        if (!planId || !container) return
        container.innerHTML = ''
        const buttons = window.paypal.Buttons({
          style: {
            layout: 'vertical',
            shape: 'rect',
            label: 'subscribe',
          },
          createSubscription: (data, actions) =>
            actions.subscription.create({
              plan_id: planId,
            }),
          onApprove: async (data) => {
            if (!data?.subscriptionID) {
              setSubscriptionError('Subscription approval was missing an ID.')
              return
            }
            setSubscriptionMessage('Confirming your subscription...')
            try {
              const response = await fetch('/api/subscription/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ subscriptionId: data.subscriptionID }),
              })
              const result = await response.json().catch(() => ({}))
              if (!response.ok) {
                throw new Error(result?.error || 'Subscription verification failed')
              }
              setSubscriptionMessage(
                `Subscription ${result?.status || 'submitted'} (ID: ${
                  result?.subscriptionId || data.subscriptionID
                }).`,
              )
              setSubscriptionError('')
            } catch (err) {
              console.error('Subscription verification failed:', err)
              setSubscriptionMessage('')
              setSubscriptionError(
                err instanceof Error ? err.message : 'Subscription verification failed.',
              )
            }
          },
          onError: (err) => {
            console.error('PayPal Buttons error:', err)
            setSubscriptionError('Payment failed to initialize. Please try again.')
          },
        })
        buttons.render(container)
        activeButtons.set(planId, buttons)
      })
    }

    renderButtons().catch((err) => {
      console.error('PayPal Buttons render failed:', err)
      setSubscriptionError('Unable to load the PayPal checkout flow.')
    })

    return () => {
      cancelled = true
      activeButtons.forEach((buttons) => {
        if (buttons?.close) {
          buttons.close()
        }
      })
    }
  }, [authUser, chargeConsent, subscriptionConfig, subscriptionPlans, page])

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

  const goToPage = (nextPage) => {
    if (nextPage === 'subscription') {
      window.location.hash = 'subscription'
    } else if (nextPage === 'admin') {
      window.location.hash = 'admin'
    } else {
      window.location.hash = ''
    }
  }

  const updatePlanForm = (field, value) => {
    setPlanForm((prev) => ({ ...prev, [field]: value }))
  }

  const setPlanButtonRef = (planId) => (node) => {
    if (!planId) return
    if (node) {
      planButtonRefs.current.set(planId, node)
    } else {
      planButtonRefs.current.delete(planId)
    }
  }

  const submitPlan = async (event) => {
    event.preventDefault()
    setAdminError('')
    try {
      const response = await fetch('/api/admin/plans/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(planForm),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to create plan')
      }
      setPlanForm((prev) => ({
        ...prev,
        planName: '',
        planDescription: '',
      }))
      const refreshed = await fetch('/api/admin/plans', { credentials: 'include' })
      if (refreshed.ok) {
        const refreshedData = await refreshed.json()
        setAdminPlans(Array.isArray(refreshedData?.plans) ? refreshedData.plans : [])
      }
      setAdminError('')
    } catch (err) {
      console.error('Plan create failed:', err)
      setAdminError(err instanceof Error ? err.message : 'Failed to create plan.')
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

      <div className="nav">
        <button
          type="button"
          className={page === 'home' ? 'active' : ''}
          onClick={() => goToPage('home')}
        >
          Home
        </button>
        <button
          type="button"
          className={page === 'subscription' ? 'active' : ''}
          onClick={() => goToPage('subscription')}
        >
          Subscription
        </button>
        {isAdmin ? (
          <button
            type="button"
            className={page === 'admin' ? 'active' : ''}
            onClick={() => goToPage('admin')}
          >
            Admin
          </button>
        ) : null}
      </div>

      {page === 'home' ? (
        <>
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
                    {authExpiry ? (
                      <p className="muted">Expires: {formatExpiry(authExpiry)}</p>
                    ) : null}
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
                <p className="hint">
                  Set GOOGLE_CLIENT_ID and AUTH_SESSION_SECRET to enable login.
                </p>
              ) : null}
            </section>

            <section className="card">
              <h2>Protected API example</h2>
              <p className="muted">
                Calls <code>/api/secret</code> with credentials. Use this pattern for any authenticated
                route.
              </p>
              <div className="actions">
                <button
                  className="secondary"
                  type="button"
                  onClick={fetchSecret}
                  disabled={authLoading}
                >
                  Call protected endpoint
                </button>
              </div>
              {secretMessage ? <p className="muted">{secretMessage}</p> : null}
            </section>

            <section className="card">
              <h2>Setup checklist</h2>
              <ul>
                <li>Create a Google OAuth client (Web) and copy the Client ID.</li>
                <li>
                  Set <code>GOOGLE_CLIENT_ID</code> and <code>AUTH_SESSION_SECRET</code> in{' '}
                  <code>.env</code>.
                </li>
                <li>Optional: set <code>CORS_ORIGINS</code> when hosting the client elsewhere.</li>
                <li>
                  Run <code>npm run dev</code> (server) and <code>npm run client:dev</code>{' '}
                  (client).
                </li>
              </ul>
            </section>
          </div>
        </>
      ) : page === 'subscription' ? (
        <div className="grid subscription-grid">
          <section className="card subscription-card">
            <h2>Subscription</h2>
            <p className="muted">
              Subscribe securely with PayPal checkout. You can pay with PayPal or a credit card.
            </p>
            {subscriptionLoading ? (
              <p className="muted">Loading subscription details...</p>
            ) : subscriptionConfig?.paypalConfigured ? (
              <div className="plan">
                <div>
                  <p className="plan__label">Environment</p>
                  <p className="plan__value">
                    {subscriptionConfig?.paypalEnv === 'live' ? 'Live' : 'Sandbox'}
                  </p>
                </div>
                <div>
                  <p className="plan__label">Plans available</p>
                  <p className="plan__value">{subscriptionPlans.length}</p>
                </div>
              </div>
            ) : (
              <p className="muted">
                PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.
              </p>
            )}

            {subscriptionConfig?.paypalConfigured ? (
              subscriptionConfig?.paypalEnv === 'live' ? (
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={chargeConsent}
                    onChange={(event) => setChargeConsent(event.target.checked)}
                  />
                  I understand this will charge real money in the live PayPal environment.
                </label>
              ) : (
                <p className="hint">
                  You are in PayPal sandbox mode. Use a sandbox buyer account to test.
                </p>
              )
            ) : null}

            {!authUser ? (
              <div className="notice warn">Sign in to enable the subscription checkout.</div>
            ) : null}
            {subscriptionPlansError ? (
              <div className="notice error">{subscriptionPlansError}</div>
            ) : null}
            {subscriptionError ? <div className="notice error">{subscriptionError}</div> : null}
            {subscriptionMessage ? (
              <div className="notice success">{subscriptionMessage}</div>
            ) : null}

            <div className="plan-grid">
              {subscriptionPlansLoading ? (
                <p className="muted">Loading plans...</p>
              ) : subscriptionPlans.length ? (
                subscriptionPlans.map((plan) => (
                  <div className="plan-card" key={plan.paypal_plan_id}>
                    <div className="plan-card__header">
                      <div>
                        <p className="plan__label">Plan</p>
                        <p className="plan__value">{plan.plan_name || 'Subscription plan'}</p>
                      </div>
                      <div>
                        <p className="plan__label">Price</p>
                        <p className="plan__value">
                          {plan.price_value} {plan.currency_code}
                        </p>
                      </div>
                      <div>
                        <p className="plan__label">Billing</p>
                        <p className="plan__value">
                          Every {plan.billing_interval_count} {plan.billing_interval_unit}
                        </p>
                      </div>
                    </div>
                    {plan.plan_description ? (
                      <p className="muted">{plan.plan_description}</p>
                    ) : null}
                    <div className="paypal" ref={setPlanButtonRef(plan.paypal_plan_id)} />
                  </div>
                ))
              ) : (
                <p className="muted">No subscription plans available yet.</p>
              )}
            </div>
          </section>
        </div>
      ) : (
        <div className="grid subscription-grid">
          <section className="card subscription-card">
            <h2>Admin: Create PayPal plan</h2>
            <p className="muted">
              Create a PayPal product + subscription plan and store the plan ID in the database.
            </p>
            {!authUser ? (
              <div className="notice warn">Sign in to access admin tools.</div>
            ) : null}
            {adminLoading ? <p className="muted">Checking admin access...</p> : null}
            {!adminLoading && authUser && !isAdmin ? (
              <div className="notice error">Admin access required.</div>
            ) : null}

            {isAdmin ? (
              <>
                <form className="admin-form" onSubmit={submitPlan}>
                  <div className="form-row">
                    <label>
                      Product name
                      <input
                        value={planForm.productName}
                        onChange={(event) => updatePlanForm('productName', event.target.value)}
                        placeholder="Aurum Data"
                        required
                      />
                    </label>
                    <label>
                      Product description
                      <input
                        value={planForm.productDescription}
                        onChange={(event) =>
                          updatePlanForm('productDescription', event.target.value)
                        }
                        placeholder="Premium analytics subscription"
                      />
                    </label>
                  </div>
                  <div className="form-row">
                    <label>
                      Plan name
                      <input
                        value={planForm.planName}
                        onChange={(event) => updatePlanForm('planName', event.target.value)}
                        placeholder="Monthly plan"
                      />
                    </label>
                    <label>
                      Plan description
                      <input
                        value={planForm.planDescription}
                        onChange={(event) => updatePlanForm('planDescription', event.target.value)}
                        placeholder="Billed monthly"
                      />
                    </label>
                  </div>
                  <div className="form-row">
                    <label>
                      Price
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={planForm.price}
                        onChange={(event) => updatePlanForm('price', event.target.value)}
                        placeholder="19.00"
                        required
                      />
                    </label>
                    <label>
                      Currency
                      <input
                        value={planForm.currency}
                        onChange={(event) => updatePlanForm('currency', event.target.value)}
                        placeholder="USD"
                      />
                    </label>
                    <label>
                      Interval unit
                      <select
                        value={planForm.intervalUnit}
                        onChange={(event) => updatePlanForm('intervalUnit', event.target.value)}
                      >
                        <option value="DAY">Day</option>
                        <option value="WEEK">Week</option>
                        <option value="MONTH">Month</option>
                        <option value="YEAR">Year</option>
                      </select>
                    </label>
                    <label>
                      Interval count
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={planForm.intervalCount}
                        onChange={(event) =>
                          updatePlanForm('intervalCount', Number(event.target.value))
                        }
                      />
                    </label>
                  </div>
                  <div className="actions">
                    <button type="submit">Create product + plan</button>
                  </div>
                </form>
                {adminError ? <div className="notice error">{adminError}</div> : null}
                <div className="divider" />
                <h3>Created plans</h3>
                {adminPlansLoading ? (
                  <p className="muted">Loading plans...</p>
                ) : adminPlans.length ? (
                  <div className="plan-table">
                    <div className="plan-row plan-row--header">
                      <span>Plan</span>
                      <span>Price</span>
                      <span>Interval</span>
                      <span>Plan ID</span>
                    </div>
                    {adminPlans.map((plan) => (
                      <div className="plan-row" key={plan.paypal_plan_id}>
                        <span>{plan.plan_name || 'Plan'}</span>
                        <span>
                          {plan.price_value} {plan.currency_code}
                        </span>
                        <span>
                          {plan.billing_interval_count} {plan.billing_interval_unit}
                        </span>
                        <span className="mono">
                          {plan.paypal_plan_id}
                          {plan.paypal_plan_id ? (
                            <>
                              {' '}
                              <a
                                href={`${paypalPlanBaseUrl}${plan.paypal_plan_id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="plan-link"
                              >
                                View
                              </a>
                            </>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">No plans created yet.</p>
                )}
              </>
            ) : null}
          </section>
        </div>
      )}
    </div>
  )
}

export default App
