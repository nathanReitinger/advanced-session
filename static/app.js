/* Workshop walkthrough: "Who am I?", check boxes, and who is done with each step.
   Check marks are kept by app.py on the laptop or, in the GitHub Pages version, in Firebase. */
(() => {
  'use strict';

  const CFG = window.WORKSHOP;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const saved = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: fine */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const TOKEN_KEY = CFG.tokenKey || 'ws.token';
  let token = saved.get(TOKEN_KEY);
  let me = null;          // { id, name }
  let mine = new Set();   // the boxes I have ticked
  let room = null;        // everyone's names and ticks: { v, boot, people: [[id, name]], checks: {item: [ids]},
                          //   online: [ids] (GitHub Pages version: who has the page open right now) }

  const stepOf = {};
  CFG.steps.forEach(s => { stepOf[s.done] = s; s.verify.forEach(v => { stepOf[v] = s; }); });
  const stepEl = s => $(`details.step[data-step="${s.id}"]`);
  const verified = s => s.verify.every(v => mine.has(v));
  const fail = (status, message, data) => Object.assign(new Error(message), { status, data });

  // Both keep check marks with the same calls: me(), join(name), check(item, on), watch(onRoom), refresh().
  const backend = CFG.firebase ? firebaseBackend() : laptopBackend();

  // ------------------------------------------------- check marks kept by app.py (laptop)

  function laptopBackend() {
    async function api(path, body) {
      const opts = {
        method: body === undefined ? 'GET' : 'POST',
        cache: 'no-store',
        // The ngrok header only matters if the site is shared through ngrok: it skips ngrok's warning page.
        headers: { Accept: 'application/json', 'ngrok-skip-browser-warning': '1' },
      };
      if (token) opts.headers['X-Token'] = token;
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(path, opts);
      let data = {};
      try { data = await res.json(); } catch { /* not JSON */ }
      if (!res.ok) throw fail(res.status, data.error || `Error ${res.status}`, data);
      return data;
    }

    // Ask for the room every few seconds while this tab is visible; pause while it is hidden, and
    // after a few minutes with no clicks, keys, scrolling or mouse movement (every request counts
    // against ngrok's free plan). Any of those starts it again.
    let listener = null;
    let pollTimer = 0;
    let polling = false;
    let pollAgain = false;
    let failures = 0;
    const IDLE_MS = 3 * 60 * 1000;
    let lastActive = Date.now();
    let idle = false;

    async function poll() {
      if (!listener) return;
      if (polling) { pollAgain = true; return; }
      clearTimeout(pollTimer);
      polling = true;
      try {
        const data = await api(`/api/state${room ? `?since=${room.v}` : ''}`);
        if (!data.same) listener(data);
        failures = 0;
      } catch {
        failures += 1;
      } finally {
        polling = false;
      }
      if (pollAgain) { pollAgain = false; poll(); return; }
      if (!document.hidden) {
        if (Date.now() - lastActive > IDLE_MS) { idle = true; return; }
        const wait = CFG.pollMs * Math.min(2 ** failures, 6) * (0.8 + Math.random() * 0.4);
        pollTimer = setTimeout(poll, wait);
      }
    }

    ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'touchstart'].forEach(type => {
      addEventListener(type, () => {
        lastActive = Date.now();
        if (idle && listener && !document.hidden) { idle = false; poll(); }
      }, { capture: true, passive: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !listener) return;
      lastActive = Date.now();
      idle = false;
      poll();
    });

    return {
      me: () => api('/api/me'),
      join: name => api('/api/join', { name }),
      check: (item, checked) => api('/api/check', { item, checked }),
      watch(onRoom) { listener = onRoom; poll(); },
      refresh: poll,
    };
  }

  // -------------------------------------------- check marks kept in Firebase (GitHub Pages)

  function firebaseBackend() {
    const base = `rooms/${CFG.room}`;
    let fb = null;
    let app = null;
    let db = null;
    let connected = false;
    let here = null;   // the person this tab says is on the page
    let mark = null;
    const ready = (async () => {
      const [appSdk, dbSdk] = await Promise.all([
        import(`${CFG.firebaseSdk}/firebase-app.js`), import(`${CFG.firebaseSdk}/firebase-database.js`)]);
      fb = dbSdk;
      app = appSdk.initializeApp(CFG.firebase);
      db = dbSdk.getDatabase(app);
      fb.onValue(fb.ref(db, '.info/connected'), snap => {
        connected = snap.val() === true;
        markHere();
      });
    })();
    const node = path => fb.ref(db, `${base}/${path}`);

    // Who is on the page right now: while this tab is open and connected it keeps a mark under
    // online/<person>, and Firebase deletes the mark as soon as the tab closes or loses its connection.
    function markHere() {
      if (!here || !connected) return;
      const m = mark = fb.push(node(`online/${here}`));
      fb.onDisconnect(m).remove()
        .then(() => fb.set(m, true))
        .catch(() => { /* rules without "online": the room counts everyone who checked in */ });
    }
    function setHere(id) {
      if (mark) {
        fb.onDisconnect(mark).cancel().catch(() => {});
        fb.remove(mark).catch(() => {});
        mark = null;
      }
      here = id;
      markHere();
    }

    // A person is their name (ignoring case and spacing), so typing the same name on another
    // browser brings your check marks back, as on the laptop version.
    async function idFor(name) {
      const key = name.trim().split(/\s+/).join(' ').toLowerCase();
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
      return Array.from(hash.slice(0, 12), b => b.toString(16).padStart(2, '0')).join('');
    }
    async function ticksOf(id) {
      return Object.keys((await fb.get(node(`checks/${id}`))).val() || {});
    }

    // The instructor's sign-in (Firebase Authentication), loaded only when someone opens it.
    let authSdk = null;
    let auth = null;
    async function instructorAuth() {
      await ready;
      if (!auth) {
        const sdk = await import(`${CFG.firebaseSdk}/firebase-auth.js`);
        auth = sdk.initializeAuth(app, { persistence: [sdk.indexedDBLocalPersistence, sdk.browserLocalPersistence] });
        authSdk = sdk;
      }
      return auth;
    }

    let version = 0;
    return {
      async onInstructor(show) {
        const a = await instructorAuth();
        authSdk.onAuthStateChanged(a, user => show(user ? user.email : null));
      },
      async signIn(email, password) {
        const a = await instructorAuth();
        await authSdk.signInWithEmailAndPassword(a, email, password);
      },
      async signOut() {
        const a = await instructorAuth();
        await authSdk.signOut(a);
      },
      async clearAll() {   // the database rules allow this for the instructor's account only
        await ready;
        await fb.remove(fb.ref(db, base));
      },
      async me() {
        await ready;
        const person = await fb.get(node(`people/${token}`));
        if (!person.exists()) throw fail(401, 'Please check in again.');
        setHere(token);
        return { id: token, name: person.val().name, mine: await ticksOf(token) };
      },
      async join(typed) {
        await ready;
        const name = typed.replace(/[\x00-\x1f\x7f]/g, ' ').trim().split(/\s+/).join(' ').slice(0, 60).trim();
        const id = await idFor(name);
        let person = await fb.get(node(`people/${id}`));
        const rejoined = person.exists();
        if (!rejoined) {
          try {
            await fb.set(node(`people/${id}`), { name, joined: Date.now() });
          } catch (err) {   // the same name checked in from another browser at this very moment
            person = await fb.get(node(`people/${id}`));
            if (!person.exists()) throw err;
          }
        }
        setHere(id);
        return { token: id, id, name: person.exists() ? person.val().name : name, mine: await ticksOf(id), rejoined };
      },
      async check(item, checked) {
        await ready;
        const s = stepOf[item];
        const have = new Set(await ticksOf(token));
        if (checked && item === s.done && !s.verify.every(v => have.has(v))) {
          throw fail(409, 'Tick the Verify box first.', { mine: [...have] });
        }
        const changes = { [item]: checked ? true : null };
        // Unticking the step unticks its Verify boxes too; unticking a Verify box un-does the step.
        if (!checked) (item === s.done ? s.verify : [s.done]).forEach(other => { changes[other] = null; });
        await fb.update(node(`checks/${token}`), changes);
        Object.entries(changes).forEach(([k, on]) => (on ? have.add(k) : have.delete(k)));
        return { mine: [...have] };
      },
      async watch(onRoom) {
        await ready;
        fb.onValue(fb.ref(db, base), snap => {
          const val = snap.val() || {};
          const people = Object.entries(val.people || {})
            .map(([id, p]) => [id, String((p && p.name) || '')])
            .sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: 'base' }) || (a[0] < b[0] ? -1 : 1));
          const checks = {};
          Object.entries(val.checks || {}).forEach(([id, items]) => {
            Object.keys(items || {}).forEach(item => { (checks[item] = checks[item] || []).push(id); });
          });
          version += 1;
          onRoom({ v: version, boot: 'firebase', people, checks, online: Object.keys(val.online || {}) });
        });
        // Firebase's free plan allows 100 open connections at once, so a tab left hidden for an hour
        // (longer than the session) lets go of its connection, and picks it up again when it is shown.
        // Until then it still counts as on the page, even while its owner works in another window.
        let offline = 0;
        document.addEventListener('visibilitychange', () => {
          clearTimeout(offline);
          if (document.hidden) offline = setTimeout(() => fb.goOffline(db), 60 * 60 * 1000);
          else fb.goOnline(db);
        });
      },
      refresh() { /* Firebase sends changes as they happen */ },
    };
  }

  async function loadMe() {
    try {
      const r = await backend.me();
      me = { id: r.id, name: r.name };
      mine = new Set(r.mine);
      showMe(); showMine(); showRoom();
    } catch (err) {
      if (err.status === 401) stale();
      else throw err;
    }
  }

  // Keep the room up to date from here on.
  let watching = false;
  function watch() {
    if (watching) return;
    watching = true;
    backend.watch(data => {
      if (room && data.v < room.v) return;
      const restarted = room && data.boot !== room.boot;
      room = data;
      showRoom();
      if (token && (!me || restarted)) loadMe().catch(() => {});
      if (CFG.firebase && me && !rejoining && !room.people.some(([id]) => id === me.id)) rejoin();
    });
  }

  // The room was cleared (by the instructor, or in the Firebase console). Check back in under the
  // same name, with nothing ticked, so the room shows who is really here.
  let rejoining = false;
  async function rejoin() {
    rejoining = true;
    try {
      const r = await backend.join(me.name);
      token = r.token;
      saved.set(TOKEN_KEY, token);
      me = { id: r.id, name: r.name };
      mine = new Set(r.mine);
      showMe(); showMine(); showRoom();
    } catch {
      stale();
    } finally {
      rejoining = false;
    }
  }

  // ---------------------------------------------------------------- who am I

  const overlay = $('#whoami');
  const nameInput = $('#whoami-name');
  const nameError = $('#whoami-error');

  function openWhoami() {
    nameError.hidden = true;
    overlay.hidden = false;
    setTimeout(() => nameInput.focus(), 40);
  }

  function stale() {   // the room no longer knows us (check marks were cleared)
    token = null; me = null; mine = new Set();
    saved.del(TOKEN_KEY);
    document.documentElement.classList.add('need-name');
    showMe(); showMine(); showRoom();
    openWhoami();
  }

  // Your name, top right.
  function showMe() {
    const tag = $('#me-tag');
    tag.hidden = !me;
    $('span', tag).textContent = me ? me.name : '';
    tag.title = me ? `You checked in as ${me.name}` : '';
  }

  $('#whoami-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { nameError.textContent = 'Please type your name.'; nameError.hidden = false; return; }
    const button = $('.primary', e.target);
    button.disabled = true;
    try {
      const r = await backend.join(name);
      token = r.token;
      saved.set(TOKEN_KEY, token);
      me = { id: r.id, name: r.name };
      mine = new Set(r.mine);
      overlay.hidden = true;
      document.documentElement.classList.remove('need-name');
      showMe(); showMine(); showRoom();
      watch();
      backend.refresh();
    } catch (err) {
      nameError.textContent = err.status ? err.message : "Can't reach the workshop site. Check your connection and try again.";
      nameError.hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  // -------------------------------------------------------------- check boxes

  let saving = Promise.resolve();
  let unsaved = 0;

  document.addEventListener('change', e => {
    const input = e.target.closest && e.target.closest('input[data-item]');
    if (!input) return;
    if (!token) { input.checked = !input.checked; openWhoami(); return; }
    const item = input.dataset.item;
    const on = input.checked;
    tickLocally(item, on);
    showMine(); showRoom();
    unsaved += 1;
    saving = saving.then(() => save(item, on));
  });

  async function save(item, on) {
    if (!token) { unsaved = 0; return; }
    try {
      const r = await backend.check(item, on);
      if (unsaved === 1) mine = new Set(r.mine);   // later clicks are still on their way
    } catch (err) {
      if (err.status === 401) { unsaved = 0; stale(); return; }
      if (err.data && err.data.mine) mine = new Set(err.data.mine);
      else tickLocally(item, !on);
      toast(err.status === 409 ? err.message : "Couldn't save that. Check your connection and try again.");
    } finally {
      unsaved = Math.max(0, unsaved - 1);
    }
    showMine(); showRoom(); backend.refresh();
  }

  function tickLocally(item, on) {
    const s = stepOf[item];
    if (on) mine.add(item);
    else {
      mine.delete(item);
      // Unticking the step unticks its Verify boxes too; unticking a Verify box un-does the step.
      (item === s.done ? s.verify : [s.done]).forEach(other => mine.delete(other));
    }
  }

  // Verify comes first: "done with the step" stays locked until the step's Verify boxes are ticked.
  function showMine() {
    $$('input[data-item]').forEach(input => { input.checked = mine.has(input.dataset.item); });
    CFG.steps.forEach(s => {
      const el = stepEl(s);
      const done = mine.has(s.done);
      const locked = !done && !verified(s);
      el.classList.toggle('is-done', done);
      const dot = $(`.toc a[data-step="${s.id}"]`);
      if (dot) dot.classList.toggle('done', done);
      $('.finish', el).classList.toggle('locked', locked);
      $(`input[data-item="${s.done}"]`, el).disabled = locked;
    });
  }

  // -------------------------------------------------------------- the room

  const PIE = 2 * Math.PI * 8;   // the pie's slice is a dash around a circle of radius 8

  function showRoom() {
    if (!room) return;
    const sets = {};
    Object.entries(room.checks).forEach(([item, ids]) => { sets[item] = new Set(ids); });
    const has = (item, id) => (me && id === me.id ? mine.has(item) : Boolean(sets[item] && sets[item].has(id)));
    // Everyone with the page open right now. (The laptop version counts everyone who checked in.)
    const online = room.online && room.online.length ? new Set(room.online) : null;
    const people = online ? room.people.filter(([id]) => online.has(id) || (me && id === me.id)) : room.people;
    let total = 0;
    CFG.steps.forEach(s => {
      const rows = people.map(([id, name]) => ({ id, name, done: has(s.done, id) }));
      const done = rows.filter(p => p.done).length;
      total += done;
      const count = $('.room-count', stepEl(s));
      count.textContent = `${done}/${rows.length}`;
      count.title = `${done} of the ${rows.length} ${online ? 'people on the website now' : 'people who checked in'} `
        + `${done === 1 ? 'is' : 'are'} done`;
      drawGrid($('.grid', stepEl(s)), rows);
      const row = $(`.stats-row[data-step="${s.id}"] dd`);
      if (row) row.textContent = `${done}/${rows.length}`;
    });

    // The Progress box: how many people are here, and a pie of every step done by everyone together.
    const stats = $('.stats');
    if (!stats) return;
    $('.stats-here dt', stats).textContent = online ? 'On the website now' : 'Checked in';
    $('.stats-here dd', stats).textContent = people.length;
    const slots = people.length * CFG.steps.length;
    $('.pie-fill', stats).setAttribute('stroke-dasharray', `${slots ? ((PIE * total) / slots).toFixed(2) : 0} ${PIE.toFixed(2)}`);
    $('summary', stats).title = `Every step, everyone together: ${total} of ${slots} done`;
  }

  function initials(name) {
    const parts = name.trim().split(/\s+/);
    const first = Array.from(parts[0] || '?')[0] || '?';
    const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] : '';
    return (first + last).toUpperCase();
  }

  // One small square per person (hover for the name), kept in place between updates.
  function drawGrid(grid, rows) {
    const cells = grid.cells || (grid.cells = new Map());
    const keep = new Set();
    let at = grid.firstChild;
    rows.forEach(p => {
      keep.add(p.id);
      let cell = cells.get(p.id);
      if (!cell) {
        cell = document.createElement('span');
        cell.setAttribute('role', 'listitem');
        cells.set(p.id, cell);
      }
      if (cell.dataset.name !== p.name) {
        cell.dataset.name = p.name;
        cell.textContent = initials(p.name);
      }
      const cls = p.done ? 'cell done' : 'cell';
      if (cell.className !== cls) cell.className = cls;
      const label = `${p.name}: ${p.done ? 'done' : 'not done yet'}`;
      if (cell.title !== label) {
        cell.title = label;
        cell.setAttribute('aria-label', label);
      }
      if (cell === at) at = at.nextSibling;
      else grid.insertBefore(cell, at);
    });
    cells.forEach((cell, id) => {
      if (!keep.has(id)) { cell.remove(); cells.delete(id); }
    });
  }

  // ------------------------------------------------------------ the timeline

  // One dot per step, on the right. A step's dot turns green with a check mark once you are done
  // with it (showMine does that), and clicking a step opens it and takes you there.
  const toc = $('.toc');
  if (toc) {
    toc.addEventListener('click', e => {
      const a = e.target.closest('a[data-step]');
      if (!a) return;
      e.preventDefault();
      const step = $(`details.step[data-step="${a.dataset.step}"]`);
      step.open = true;
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      step.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    });
  }

  // ------------------------------------------------------------ instructor

  // GitHub Pages version only. The instructor signs in with the email and password of the account
  // made in Firebase (Authentication), and can then clear the room.
  const teacher = $('#instructor');
  if (teacher) {
    const form = $('#instructor-form');
    const panel = $('#instructor-panel');
    const problem = $('#instructor-error');
    const note = $('#instructor-note');
    const say = (el, msg) => { el.textContent = msg || ''; el.hidden = !msg; };
    let listening = false;

    const showTeacher = email => {   // the signed-in instructor's email, or null
      form.hidden = Boolean(email);
      panel.hidden = !email;
      $('#instructor-who').textContent = email || '';
    };
    async function openTeacher() {
      say(problem, ''); say(note, '');
      teacher.hidden = false;
      if (!listening) {
        listening = true;
        try {
          await backend.onInstructor(showTeacher);   // loads Firebase Authentication the first time
        } catch {
          listening = false;
          say(problem, "Can't reach the sign-in service. Check your connection and try again.");
        }
      }
      setTimeout(() => (panel.hidden ? $('#instructor-email') : $('#clear-all')).focus(), 40);
    }
    const closeTeacher = () => { teacher.hidden = true; };

    $$('[data-instructor]').forEach(button => button.addEventListener('click', openTeacher));
    $('#instructor-close').addEventListener('click', closeTeacher);
    teacher.addEventListener('keydown', e => { if (e.key === 'Escape') closeTeacher(); });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const email = $('#instructor-email').value.trim();
      const password = $('#instructor-password').value;
      if (!email || !password) { say(problem, 'Type your email and password.'); return; }
      const button = $('.primary', form);
      button.disabled = true;
      say(problem, '');
      try {
        await backend.signIn(email, password);
        $('#instructor-password').value = '';
      } catch (err) {
        say(problem, signInProblem(err));
      } finally {
        button.disabled = false;
      }
    });
    $('#instructor-out').addEventListener('click', () => { say(note, ''); backend.signOut().catch(() => {}); });

    $('#clear-all').addEventListener('click', async () => {
      if (!confirm('Clear everyone?\n\nThis removes every name and check mark. Anyone with the page open '
        + 'is checked back in under the same name, with nothing ticked.')) return;
      say(problem, ''); say(note, '');
      try {
        await backend.clearAll();
        say(note, 'Cleared. Everyone starts fresh.');
      } catch {
        say(problem, "Couldn't clear: the database rules don't allow this account yet (see HOW-TO-RUN.md).");
      }
    });
  }

  function signInProblem(err) {
    const code = (err && err.code) || '';
    if (/invalid-credential|wrong-password|user-not-found|invalid-email|invalid-login/.test(code)) return 'Wrong email or password.';
    if (code.includes('too-many-requests')) return 'Too many tries. Wait a minute, then try again.';
    if (/operation-not-allowed|configuration-not-found|admin-restricted/.test(code)) {
      return 'Email and password sign-in is not turned on in Firebase yet (Authentication, Sign-in method).';
    }
    if (code.includes('network-request-failed')) return "Can't reach the sign-in service. Check your connection and try again.";
    return "Couldn't sign in. Try again.";
  }

  // ------------------------------------------------------------------ images

  // Screenshots load only when their dropdown is opened.
  function loadImages(root) {
    $$('img[data-src]', root).forEach(img => {
      if (img.closest('details:not([open])')) return;
      img.src = img.dataset.src;
      img.removeAttribute('data-src');
    });
  }
  document.addEventListener('toggle', e => { if (e.target.open) loadImages(e.target); }, true);

  // --------------------------------------------- only shown if a save fails

  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
  }

  // ------------------------------------------------------------------ start

  async function start() {
    showMine(); loadImages(document);
    if (!token) { openWhoami(); return; }
    try { await loadMe(); } catch { /* the room updates below keep trying */ }
    if (token) watch();
  }

  start();
})();
