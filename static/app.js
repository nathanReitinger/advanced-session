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
                          //   here: { humans, bots, people: [ids] } (GitHub Pages version: who has the page open) }

  const stepOf = {};
  CFG.steps.forEach(s => { stepOf[s.done] = s; s.verify.forEach(v => { stepOf[v] = s; }); });
  const stepEl = s => $(`details.step[data-step="${s.id}"]`);
  const verified = s => s.verify.every(v => mine.has(v));
  const fail = (status, message, data) => Object.assign(new Error(message), { status, data });

  // This browser's visitor id (all its tabs share it), for counting who is on the website.
  function browserId() {
    const key = 'ws.visitor';
    let id = saved.get(key);
    if (!/^[0-9a-f]{16}$/.test(id || '')) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
      saved.set(key, id);
    }
    return id;
  }
  // Automated browsers usually say so: the WebDriver flag, or a user agent such as HeadlessChrome
  // or "...bot...". Crawlers that do not run the page's script never connect, so they are not counted.
  function looksAutomated() {
    try { if (navigator.webdriver) return true; } catch { /* ignore */ }
    return /bot\b|crawl|spider|slurp|headless|lighthouse|phantomjs|puppeteer|playwright|selenium/i.test(navigator.userAgent || '');
  }

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
    let db = null;
    const ready = (async () => {
      const [appSdk, dbSdk] = await Promise.all([
        import(`${CFG.firebaseSdk}/firebase-app.js`), import(`${CFG.firebaseSdk}/firebase-database.js`)]);
      fb = dbSdk;
      db = dbSdk.getDatabase(appSdk.initializeApp(CFG.firebase));
      fb.onValue(fb.ref(db, '.info/connected'), snap => { if (snap.val() === true) newMark(); });
    })();
    const node = path => fb.ref(db, `${base}/${path}`);

    // Who is on the page right now. Every open tab, checked in or not, keeps a mark under
    // here/<browser>/<tab> while it is connected, and Firebase deletes the mark as soon as the tab
    // closes or loses its connection. The mark says who the tab checked in as (if anyone) and
    // whether the browser says it is automated (a bot).
    const visitor = browserId();
    const bot = looksAutomated();
    let person = '';
    let mark = null;
    let stopWatching = null;
    let writing = false;
    let again = false;
    let refused = false;   // the database rules have no "here" yet

    function newMark() {   // on every (re)connection; Firebase has deleted the old mark itself
      if (stopWatching) stopWatching();
      const m = mark = fb.push(node(`here/${visitor}`));
      fb.onDisconnect(m).remove().catch(() => {});
      writeMark();
      // Put the mark back if it disappears while we are connected (the room was cleared).
      stopWatching = fb.onValue(m, snap => { if (!snap.exists() && m === mark) writeMark(); });
    }
    async function writeMark() {
      if (!mark || refused) return;
      if (writing) { again = true; return; }
      writing = true;
      try {
        await fb.set(mark, { p: person, bot });
      } catch {
        try {   // checked in as someone the room no longer has (it was just cleared): count the tab anyway
          if (!person) throw new Error('refused');
          await fb.set(mark, { p: '', bot });
        } catch {
          refused = true;
        }
      } finally {
        writing = false;
      }
      if (again) { again = false; writeMark(); }
    }
    function setPerson(id) {
      person = id || '';
      writeMark();
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

    // The instructor's password is checked by the database rules (firebase-rules.json): writing it
    // to instructor/<room> only works with the right one, and a room can only be cleared together
    // with that write.
    const instructorMark = password => ({ password, at: fb.serverTimestamp() });

    let version = 0;
    return {
      async instructorCheck(password) {
        await ready;
        await fb.set(fb.ref(db, `instructor/${CFG.room}`), instructorMark(password));
      },
      async clearAll(password) {
        await ready;
        await fb.update(fb.ref(db), { [base]: null, [`instructor/${CFG.room}`]: instructorMark(password) });
      },
      async me() {
        await ready;
        const person = await fb.get(node(`people/${token}`));
        if (!person.exists()) throw fail(401, 'Please check in again.');
        setPerson(token);
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
        setPerson(id);
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
          // One browser is one visitor, however many tabs it has open.
          const visitors = Object.values(val.here || {}).map(tabs => Object.values(tabs || {}));
          const bots = visitors.filter(tabs => tabs.some(m => m && m.bot)).length;
          const present = new Set(visitors.flat().map(m => m && m.p).filter(Boolean));
          const here = val.here ? { humans: visitors.length - bots, bots, people: [...present] } : null;
          version += 1;
          onRoom({ v: version, boot: 'firebase', people, checks, here });
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

  function showRoom() {
    if (!room) return;
    const sets = {};
    Object.entries(room.checks).forEach(([item, ids]) => { sets[item] = new Set(ids); });
    const has = (item, id) => (me && id === me.id ? mine.has(item) : Boolean(sets[item] && sets[item].has(id)));
    // Everyone with the page open right now. (The laptop version, and a database whose rules have
    // no "here" yet, count everyone who checked in.)
    const here = room.here;
    const online = here ? new Set(here.people) : null;
    const people = online ? room.people.filter(([id]) => online.has(id) || (me && id === me.id)) : room.people;
    CFG.steps.forEach(s => {
      const rows = people.map(([id, name]) => ({ id, name, done: has(s.done, id) }));
      const done = rows.filter(p => p.done).length;
      const count = $('.room-count', stepEl(s));
      count.textContent = `${done}/${rows.length}`;
      count.title = `${done} of the ${rows.length} ${online ? 'people on the website now' : 'people who checked in'} `
        + `${done === 1 ? 'is' : 'are'} done`;
      drawGrid($('.grid', stepEl(s)), rows);
    });

    // The box on the right: everyone on the website, checked in or not, people and bots apart.
    const stats = $('.stats');
    if (!stats) return;
    $('.stats-people .label', stats).textContent = here ? 'People' : 'Checked in';
    $('.stats-people dd', stats).textContent = here ? here.humans : people.length;
    $('.stats-bots', stats).hidden = !here;
    $('.stats-bots dd', stats).textContent = here ? here.bots : '';
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

  // GitHub Pages version only. The instructor signs in with a password, which the database rules
  // check (it is not in this page), and can then clear the room. Signing in lasts until the tab closes.
  const teacher = $('#instructor');
  if (teacher) {
    const KEY = `ws.${CFG.room}.instructor`;
    const kept = {
      get() { try { return sessionStorage.getItem(KEY); } catch { return null; } },
      set(v) { try { sessionStorage.setItem(KEY, v); } catch { /* fine: signed in until reload */ } },
      del() { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } },
    };
    let password = kept.get();
    const form = $('#instructor-form');
    const field = $('#instructor-password');
    const panel = $('#instructor-panel');
    const problem = $('#instructor-error');
    const note = $('#instructor-note');
    const say = (el, msg) => { el.textContent = msg || ''; el.hidden = !msg; };
    const showTeacher = () => { form.hidden = Boolean(password); panel.hidden = !password; };

    function openTeacher() {
      say(problem, ''); say(note, '');
      showTeacher();
      teacher.hidden = false;
      setTimeout(() => (password ? $('#clear-all') : field).focus(), 40);
    }
    $$('[data-instructor]').forEach(button => button.addEventListener('click', openTeacher));
    $('#instructor-close').addEventListener('click', () => { teacher.hidden = true; });
    teacher.addEventListener('keydown', e => { if (e.key === 'Escape') teacher.hidden = true; });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const typed = field.value;
      if (!typed) { say(problem, 'Type the password.'); return; }
      const button = $('.primary', form);
      button.disabled = true;
      say(problem, '');
      try {
        await backend.instructorCheck(typed);
        password = typed;
        kept.set(typed);
        field.value = '';
        showTeacher();
        $('#clear-all').focus();
      } catch {
        say(problem, 'Wrong password.');
      } finally {
        button.disabled = false;
      }
    });
    $('#instructor-out').addEventListener('click', () => {
      password = null;
      kept.del();
      say(note, '');
      showTeacher();
    });

    $('#clear-all').addEventListener('click', async () => {
      if (!confirm('Clear everyone?\n\nThis removes every name and check mark. Anyone with the page open '
        + 'is checked back in under the same name, with nothing ticked.')) return;
      say(problem, ''); say(note, '');
      try {
        await backend.clearAll(password);
        say(note, 'Cleared. Everyone starts fresh.');
      } catch {
        say(problem, "Couldn't clear. Sign out, then sign in again.");
      }
    });
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

  // ------------------------------------------------------------------ display

  // Text size (A- / A+), high contrast (also colour-blind friendly) and dark mode, each reader's own,
  // kept on this browser. The page's head applies them before it draws, so nothing flashes.
  const SIZES = [0.875, 1, 1.125, 1.25, 1.5];
  const root = document.documentElement;
  let display = {};
  try { display = JSON.parse(saved.get('ws.display') || '{}') || {}; } catch { display = {}; }

  function showDisplay() {
    const size = SIZES.includes(display.size) ? display.size : 1;
    if (size === 1) root.style.removeProperty('--scale'); else root.style.setProperty('--scale', size);
    if (display.dark) root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
    if (display.contrast) root.setAttribute('data-contrast', 'high'); else root.removeAttribute('data-contrast');
    $('.disp[data-size="-1"]').disabled = size === SIZES[0];
    $('.disp[data-size="1"]').disabled = size === SIZES[SIZES.length - 1];
    $('.disp[data-contrast]').setAttribute('aria-pressed', String(Boolean(display.contrast)));
    $('.disp[data-dark]').setAttribute('aria-pressed', String(Boolean(display.dark)));
  }
  function changeDisplay(change) {
    Object.assign(display, change);
    saved.set('ws.display', JSON.stringify(display));
    showDisplay();
  }
  $$('.disp[data-size]').forEach(button => button.addEventListener('click', () => {
    const at = SIZES.indexOf(SIZES.includes(display.size) ? display.size : 1);
    changeDisplay({ size: SIZES[Math.min(SIZES.length - 1, Math.max(0, at + Number(button.dataset.size)))] });
  }));
  $('.disp[data-contrast]').addEventListener('click', () => changeDisplay({ contrast: !display.contrast }));
  $('.disp[data-dark]').addEventListener('click', () => changeDisplay({ dark: !display.dark }));
  showDisplay();

  // ------------------------------------------------------------------ start

  async function start() {
    showMine(); loadImages(document);
    if (!token) { openWhoami(); return; }
    try { await loadMe(); } catch { /* the room updates below keep trying */ }
    if (token) watch();
  }

  start();
})();
