import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider, PricingTable, SignIn, SignUp, UserButton, UserProfile, useAuth, useClerk, useSession } from '@clerk/react';
import './style.css';

const params = new URLSearchParams(window.location.search);
const intent = ['billing', 'account', 'signup'].includes(params.get('intent')) ? params.get('intent') : 'signin';
const next = ['billing', 'account'].includes(params.get('next')) ? params.get('next') : 'signin';
const returnIntent = intent === 'signup' ? next : intent;
const returnUrl = `/?intent=${returnIntent}`;
const signUpUrl = `/?intent=signup&next=${returnIntent}`;
const billingReturn = params.get('checkout') === 'complete' && intent === 'billing';
const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

const appearance = {
  variables: {
    colorPrimary: '#285843',
    colorForeground: '#17322a',
    borderRadius: '0.65rem',
    fontFamily: '"Avenir Next", "Segoe UI", sans-serif',
  },
};

function Header({ signedIn }) {
  return (
    <header className="header">
      <a className="brand" href="/"><span className="mark" aria-hidden="true">C</span>CartScout</a>
      {signedIn && (
        <nav className="account-nav" aria-label="Account">
          <a href="/?intent=billing" aria-current={intent === 'billing' ? 'page' : undefined}>Plans</a>
          <a href="/?intent=account" aria-current={intent === 'account' ? 'page' : undefined}>Account</a>
          <UserButton />
        </nav>
      )}
    </header>
  );
}

function Billing() {
  const { has } = useAuth();
  const clerk = useClerk();
  const { session } = useSession();
  const pro = has?.({ plan: 'pro' }) === true;
  const sessionId = session?.id;
  const [refreshStatus, setRefreshStatus] = useState('');

  useEffect(() => {
    if (!billingReturn || pro || !sessionId) return undefined;
    let cancelled = false;
    let attempts = 0;
    let timer;

    async function refreshPlan() {
      try {
        await clerk.session?.reload();
        await clerk.session?.getToken({ skipCache: true });
      } catch {
        // A short propagation delay is expected after the development checkout.
      }
      if (cancelled) return;
      attempts += 1;
      if (attempts < 5) timer = setTimeout(refreshPlan, 1200);
      else setRefreshStatus('Your plan is still updating. Refresh this page or reopen CartScout to check again.');
    }

    void refreshPlan();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pro, sessionId, clerk]);

  return (
    <main className="billing">
      <div className="intro">
        <h1>{pro ? 'CartScout Pro is active' : 'Choose your CartScout plan'}</h1>
        <p>{pro ? 'Reopen CartScout to scan as many stores as you like and see codes we’ve already found.' : 'Free includes five store scans a week. With Pro, scan as many stores as you like and see codes we’ve already found for other members.'}</p>
        {publishableKey.startsWith('pk_test_') && <p className="notice">Test checkout · No real charges</p>}
        {billingReturn && !pro && <p role="status">{refreshStatus || 'Checking your plan…'}</p>}
      </div>
      <PricingTable
        for="user"
        newSubscriptionRedirectUrl="/?intent=billing&checkout=complete"
        fallback={<p role="status">Loading plans…</p>}
      />
      <p className="return-note"><a href="/?intent=account">Manage account and billing</a></p>
    </main>
  );
}

function Portal() {
  const { isLoaded, isSignedIn } = useAuth();
  let content;
  if (!isLoaded) {
    content = <main className="narrow"><p role="status">Loading your account…</p></main>;
  } else if (!isSignedIn) {
    content = (
      <main className="auth">
        <div className="intro">
          <h1>{intent === 'signup' ? 'Create your account' : 'Sign in to CartScout'}</h1>
          <p>{returnIntent === 'billing' ? 'Sign in to view plans and finish your upgrade.' : 'After signing in, return to your shopping tab and reopen the extension.'}</p>
        </div>
        {intent === 'signup'
          ? <SignUp routing="hash" signInUrl={returnUrl} forceRedirectUrl={returnUrl} />
          : <SignIn routing="hash" signUpUrl={signUpUrl} forceRedirectUrl={returnUrl} signUpForceRedirectUrl={returnUrl} />}
      </main>
    );
  } else if (intent === 'billing') {
    content = <Billing />;
  } else if (intent === 'account') {
    content = <main className="account-page"><h1>Manage your account</h1><UserProfile routing="hash" /></main>;
  } else {
    content = (
      <main className="narrow intro">
        <h1>You’re signed in</h1>
        <p>Go back to your shopping tab and reopen CartScout.</p>
        <a className="action" href="/?intent=billing">View plans</a>
      </main>
    );
  }

  return <><Header signedIn={isSignedIn} />{content}</>;
}

const root = createRoot(document.getElementById('root'));
root.render(publishableKey
  ? (
    <ClerkProvider
      publishableKey={publishableKey}
      appearance={appearance}
      afterSignOutUrl="/"
      signInFallbackRedirectUrl={returnUrl}
      signUpFallbackRedirectUrl={returnUrl}
    >
      <Portal />
    </ClerkProvider>
  )
  : <><Header /><main className="narrow intro"><h1>Account setup required</h1><p>Set the Clerk publishable key before starting the account portal.</p></main></>);
