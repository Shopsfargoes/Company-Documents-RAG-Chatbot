// Milestone 1 placeholder: proves static hosting and the /api route both work.
(async function () {
  const el = document.getElementById('status');
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const body = await res.json();
    if (res.ok && body.ok) {
      el.textContent = 'Backend and database are reachable.';
      el.className = 'status ok';
    } else {
      throw new Error('unhealthy');
    }
  } catch (err) {
    el.textContent = 'Backend check failed. See the terminal running vercel dev.';
    el.className = 'status bad';
  }
})();
