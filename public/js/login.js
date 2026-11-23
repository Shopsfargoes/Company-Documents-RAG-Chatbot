import { getSession, signIn, signUp, sendPasswordReset } from './auth.js';

const $ = (id) => document.getElementById(id);
const forms = {
  login: $('login-form'),
  register: $('register-form'),
  forgot: $('forgot-form'),
};
const tabs = { login: $('tab-login'), register: $('tab-register') };

function showNotice(text, kind = 'ok') {
  const el = $('notice');
  el.textContent = text;
  el.className = `notice ${kind}`;
  el.hidden = false;
}

function clearNotice() {
  $('notice').hidden = true;
}

function showForm(name) {
  for (const [key, form] of Object.entries(forms)) form.hidden = key !== name;
  for (const [key, tab] of Object.entries(tabs)) {
    tab.setAttribute('aria-selected', String(key === name));
  }
  clearNotice();
}

async function withBusy(form, work) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await work();
  } catch (err) {
    console.error(err);
    showNotice('Something went wrong. Please try again.', 'bad');
  } finally {
    button.disabled = false;
  }
}

function loginMessage(error) {
  if (error.code === 'email_not_confirmed') {
    return 'Please confirm your email address first - check your inbox.';
  }
  return 'Invalid email or password.';
}

function registerMessage(error) {
  if (error.code === 'weak_password') return error.message;
  if (error.code === 'over_email_send_rate_limit' || error.status === 429) {
    return 'Too many attempts. Please wait a few minutes and try again.';
  }
  return 'We could not create your account. Use your company email address, or ask an administrator for access.';
}

tabs.login.addEventListener('click', () => showForm('login'));
tabs.register.addEventListener('click', () => showForm('register'));
$('show-forgot').addEventListener('click', () => showForm('forgot'));
$('back-to-login').addEventListener('click', () => showForm('login'));

forms.login.addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(forms.login, async () => {
    clearNotice();
    const { error } = await signIn($('login-email').value.trim(), $('login-password').value);
    if (error) {
      showNotice(loginMessage(error), 'bad');
      return;
    }
    window.location.replace('/');
  });
});

forms.register.addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(forms.register, async () => {
    clearNotice();
    const fullName = $('register-name').value.trim();
    const email = $('register-email').value.trim();
    const password = $('register-password').value;
    const confirm = $('register-confirm').value;

    if (fullName.length < 1 || fullName.length > 200) {
      showNotice('Please enter your full name.', 'bad');
      return;
    }
    if (password.length < 10) {
      showNotice('Your password must be at least 10 characters long.', 'bad');
      return;
    }
    if (password !== confirm) {
      showNotice('The two passwords do not match.', 'bad');
      return;
    }

    const { data, error } = await signUp({ email, password, fullName });
    if (error) {
      showNotice(registerMessage(error), 'bad');
      return;
    }
    if (data.session) {
      window.location.replace('/');
      return;
    }
    forms.register.reset();
    showNotice('Almost done - check your email to confirm your account, then sign in.');
  });
});

forms.forgot.addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(forms.forgot, async () => {
    clearNotice();
    const { error } = await sendPasswordReset($('forgot-email').value.trim());
    if (error && (error.code === 'over_email_send_rate_limit' || error.status === 429)) {
      showNotice('Too many attempts. Please wait a few minutes and try again.', 'bad');
      return;
    }
    // Same message whether or not the account exists (prevents account probing).
    showNotice('If an account exists for that address, a reset link has been sent.');
  });
});

// ---- on page load ---------------------------------------------------------
const session = await getSession();
if (session) {
  window.location.replace('/');
} else {
  showForm('login');
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.slice(1));
  if (hash.get('error_description') || query.get('error_description')) {
    showNotice('That link is invalid or has expired. Please request a new one.', 'bad');
  } else if (query.get('reset') === '1') {
    showNotice('Your password was updated. Please sign in.');
  }
}