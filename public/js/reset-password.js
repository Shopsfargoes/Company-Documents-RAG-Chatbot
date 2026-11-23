import { getSession, updatePassword, signOut } from './auth.js';

const $ = (id) => document.getElementById(id);

function showNotice(text, kind = 'ok') {
  const el = $('notice');
  el.textContent = text;
  el.className = `notice ${kind}`;
  el.hidden = false;
}

const session = await getSession();
$('checking').hidden = true;

if (!session) {
  showNotice('This reset link is invalid or has expired. Please request a new one.', 'bad');
  $('back-link').hidden = false;
} else {
  const form = $('reset-form');
  form.hidden = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const password = $('new-password').value;
    const confirm = $('confirm-password').value;

    if (password.length < 10) {
      showNotice('Your password must be at least 10 characters long.', 'bad');
      return;
    }
    if (password !== confirm) {
      showNotice('The two passwords do not match.', 'bad');
      return;
    }

    button.disabled = true;
    try {
      const { error } = await updatePassword(password);
      if (error) {
        showNotice(
          error.code === 'weak_password' || error.code === 'same_password'
            ? error.message
            : 'Could not update the password. Please request a new reset link.',
          'bad',
        );
        return;
      }
      await signOut();
      window.location.replace('/login.html?reset=1');
    } catch (err) {
      console.error(err);
      showNotice('Something went wrong. Please try again.', 'bad');
    } finally {
      button.disabled = false;
    }
  });
}