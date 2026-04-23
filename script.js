/**
 * FOCUS — To-Do & Planner
 * script.js
 *
 * Architecture:
 *   StorageService  → Read/write localStorage safely
 *   StateManager    → Single source of truth for all app data
 *   TaskManager     → CRUD operations & task logic
 *   UIManager       → All DOM rendering, reads from state only
 *   PlannerManager  → Time-blocking view logic
 *   App             → Bootstrap, event wiring, init
 */

'use strict';

/* ================================================================
   FIREBASE CONFIG
   ================================================================ */
// PASTE YOUR FIREBASE CONFIG HERE:

const firebaseConfig = {
  apiKey: "AIzaSyCvcHmeipYMc2chXNd3AM82AigdWjZ9p1U",
  authDomain: "planner-2bbce.firebaseapp.com",
  projectId: "planner-2bbce",
  storageBucket: "planner-2bbce.firebasestorage.app",
  messagingSenderId: "186756838326",
  appId: "1:186756838326:web:a2ef622c19050696cd8717",
  measurementId: "G-F52RF17D34"
};

// Initialize Firebase services safely
let db = null;
let auth = null;

try {
  if (typeof firebase !== 'undefined') {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    auth = firebase.auth();
  } else {
    console.error('Firebase SDK not loaded. Check your internet connection or script tags.');
  }
} catch (e) {
  console.error('Firebase initialization failed:', e);
}

/* ================================================================
   CONSTANTS
   ================================================================ */
const STORAGE_KEY = 'focus_app_v1';
const TODAY_STR = () => new Date().toISOString().slice(0, 10);
const TIME_BLOCKS = [
  { id: 'morning', label: 'Morning', range: '6:00 – 12:00' },
  { id: 'afternoon', label: 'Afternoon', range: '12:00 – 17:00' },
  { id: 'evening', label: 'Evening', range: '17:00 – 21:00' },
  { id: 'night', label: 'Night', range: '21:00 – 24:00' },
];
const DEFAULT_CATEGORIES = ['Work', 'Personal', 'Health', 'Learning', 'Other'];
const CATEGORY_COLORS = ['#c8621a', '#2563eb', '#16a34a', '#8b5cf6', '#6b7280'];
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

/* ================================================================
   StorageService
   Handles Firestore I/O for cloud sync with local fallback.
   ================================================================ */
const StorageService = (() => {
  function getStorageKey(uid) {
    return uid ? `focus_user_${uid}` : 'focus_guest_data';
  }

  async function load(uid) {
    const localKey = getStorageKey(uid);
    if (!uid || !db) return getLocal(localKey);

    try {
      const doc = await db.collection('users').doc(uid).get();
      if (doc.exists) {
        const data = doc.data();
        saveLocal(localKey, data);
        return data;
      }
      return getLocal(localKey);
    } catch (e) {
      console.error('[StorageService] Firestore load failed:', e);
      return getLocal(localKey);
    }
  }

  async function save(uid, state) {
    const localKey = getStorageKey(uid);
    saveLocal(localKey, state);

    if (!uid || !db) return;
    try {
      await db.collection('users').doc(uid).set(state);
    } catch (e) {
      console.error('[StorageService] Firestore save failed:', e);
    }
  }

  function getLocal(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveLocal(key, state) {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch (e) { console.error('[StorageService] Local save failed:', e); }
  }

  function clearLocal(uid) {
    localStorage.removeItem(getStorageKey(uid));
  }

  return { load, save, getLocal, saveLocal, clearLocal };
})();


/* ================================================================
   StateManager
   Single source of truth. All mutations go through here.
   ================================================================ */
const StateManager = (() => {
  const DEFAULT_STATE = {
    tasks: [],
    habits: [],
    categories: DEFAULT_CATEGORIES.map((name, i) => ({
      id: `cat_${i}`,
      name,
      color: CATEGORY_COLORS[i],
    })),
    settings: {
      theme: 'light',
      activeView: 'today',
      priorityFilter: 'all',
      searchQuery: '',
      plannerDate: TODAY_STR(),
      pomodoro: {
        workTime: 25,
        breakTime: 5,
        sessionsDone: 0
      }
    },
  };

  let _state = null;
  let _uid = null;
  let _unsubscribe = null;

  async function _hydrate() {
    _uid = auth?.currentUser?.uid || null;

    if (_unsubscribe) _unsubscribe();

    let data = await StorageService.load(_uid);

    if (data && data.tasks && data.categories) {
      _state = {
        ...DEFAULT_STATE,
        ...data,
        habits: data.habits || [],
        settings: {
          ...DEFAULT_STATE.settings,
          ...data.settings,
          pomodoro: { ...DEFAULT_STATE.settings.pomodoro, ...(data.settings?.pomodoro || {}) }
        },
      };
    } else {
      _state = structuredClone(DEFAULT_STATE);
    }

    if (_uid && db) {
      console.log('[StateManager] Setting up real-time listener for UID:', _uid);
      _unsubscribe = db.collection('users').doc(_uid).onSnapshot(doc => {
        if (doc.exists) {
          const cloudData = doc.data();
          if (JSON.stringify(cloudData) !== JSON.stringify(_state)) {
            console.log('[StateManager] Cloud update received.');
            _state = { ..._state, ...cloudData };
            UIManager.render();
          }
        }
      }, err => console.error('[StateManager] Snapshot error:', err));
    }
  }

  function get() { return _state; }

  let saveTimeout = null;
  function set(mutatorFn) {
    if (!_state) return;
    mutatorFn(_state);

    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      StorageService.save(_uid, _state);
    }, 1000);
  }

  async function init() {
    await _hydrate();
  }

  return { get, set, init };
})();


/* ================================================================
   TaskManager
   All task CRUD and business logic.
   ================================================================ */
const TaskManager = (() => {
  function _uid(prefix = 'task') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function create({ title, notes = '', priority = 'medium', category = '',
    tags = [], dueDate = '', startTime = '', duration = '', timeBlock = '', recurring = false }) {
    const task = {
      id: _uid(),
      title: title.trim(),
      notes: notes.trim(),
      priority,
      category,
      tags: tags.map(t => t.trim()).filter(Boolean),
      dueDate,
      startTime,
      duration: duration ? parseInt(duration) : null,
      timeBlock,
      recurring,
      subtasks: [],
      completed: false,
      completedAt: null,
      createdAt: new Date().toISOString(),
      order: StateManager.get().tasks.length,
    };

    StateManager.set(state => state.tasks.push(task));
    return task;
  }

  function update(id, changes) {
    StateManager.set(state => {
      const idx = state.tasks.findIndex(t => t.id === id);
      if (idx === -1) return;
      Object.assign(state.tasks[idx], changes);
    });
  }

  function remove(id) {
    StateManager.set(state => {
      state.tasks = state.tasks.filter(t => t.id !== id);
    });
  }

  function toggle(id) {
    StateManager.set(state => {
      const task = state.tasks.find(t => t.id === id);
      if (!task) return;
      task.completed = !task.completed;
      task.completedAt = task.completed ? new Date().toISOString() : null;
    });
  }

  // --- Categories ---
  function addCategory(name, color) {
    const cat = { id: _uid('cat'), name, color };
    StateManager.set(state => state.categories.push(cat));
    return cat;
  }

  function removeCategory(id) {
    StateManager.set(state => {
      state.categories = state.categories.filter(c => c.id !== id);
      // Clean up tasks using this category
      state.tasks.forEach(t => {
        if (t.category === id) t.category = '';
      });
    });
  }

  // --- Subtasks ---
  function addSubtask(taskId, title) {
    StateManager.set(state => {
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return;
      if (!task.subtasks) task.subtasks = [];
      task.subtasks.push({
        id: _uid('sub'),
        title: title.trim(),
        completed: false
      });
    });
  }

  function toggleSubtask(taskId, subId) {
    StateManager.set(state => {
      const task = state.tasks.find(t => t.id === taskId);
      if (!task || !task.subtasks) return;
      const sub = task.subtasks.find(s => s.id === subId);
      if (sub) sub.completed = !sub.completed;
    });
  }

  function removeSubtask(taskId, subId) {
    StateManager.set(state => {
      const task = state.tasks.find(t => t.id === taskId);
      if (!task || !task.subtasks) return;
      task.subtasks = task.subtasks.filter(s => s.id !== subId);
    });
  }

  // --- Habits ---
  function createHabit(name) {
    const habit = {
      id: _uid('habit'),
      name: name.trim(),
      streak: 0,
      completedDates: [], // ISO strings
      color: CATEGORY_COLORS[Math.floor(Math.random() * CATEGORY_COLORS.length)]
    };
    StateManager.set(state => state.habits.push(habit));
    return habit;
  }

  function toggleHabit(habitId, dateStr) {
    StateManager.set(state => {
      const habit = state.habits.find(h => h.id === habitId);
      if (!habit) return;
      const idx = habit.completedDates.indexOf(dateStr);
      if (idx > -1) {
        habit.completedDates.splice(idx, 1);
      } else {
        habit.completedDates.push(dateStr);
      }
      // Simple streak calc: consecutive days ending today
      let streak = 0;
      let d = new Date();
      while (true) {
        const s = d.toISOString().slice(0, 10);
        if (habit.completedDates.includes(s)) {
          streak++;
          d.setDate(d.getDate() - 1);
        } else {
          break;
        }
      }
      habit.streak = streak;
    });
  }

  function removeHabit(id) {
    StateManager.set(state => {
      state.habits = state.habits.filter(h => h.id !== id);
    });
  }

  function reorder(fromId, toId) {
    StateManager.set(state => {
      const tasks = state.tasks;
      const fromIdx = tasks.findIndex(t => t.id === fromId);
      const toIdx = tasks.findIndex(t => t.id === toId);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
      const [moved] = tasks.splice(fromIdx, 1);
      tasks.splice(toIdx, 0, moved);
      tasks.forEach((t, i) => (t.order = i));
    });
  }

  function assignTimeBlock(taskId, block) {
    update(taskId, { timeBlock: block });
  }

  // Query helpers
  function getToday() {
    const today = TODAY_STR();
    return StateManager.get().tasks.filter(
      t => !t.completed && t.dueDate === today
    );
  }

  function getInbox() {
    return StateManager.get().tasks.filter(
      t => !t.completed && !t.dueDate
    );
  }

  function getUpcoming() {
    const today = TODAY_STR();
    return StateManager.get().tasks.filter(
      t => !t.completed && t.dueDate && t.dueDate > today
    );
  }

  function getCompleted() {
    return StateManager.get().tasks
      .filter(t => t.completed)
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  }

  function getByCategory(catId) {
    return StateManager.get().tasks.filter(
      t => !t.completed && t.category === catId
    );
  }

  function getForPlannerDate(dateStr) {
    return StateManager.get().tasks.filter(
      t => !t.completed && t.dueDate === dateStr
    );
  }

  // Seed recurring tasks for today if they don't exist yet
  function seedRecurring() {
    const today = TODAY_STR();
    StateManager.set(state => {
      const recurringTemplates = state.tasks.filter(
        t => t.recurring && t.dueDate !== today
      );
      for (const tmpl of recurringTemplates) {
        // If no completed copy exists for today, create one
        const alreadyExists = state.tasks.some(
          t => t.title === tmpl.title && t.dueDate === today
        );
        if (!alreadyExists) {
          state.tasks.push({
            ...tmpl,
            id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            dueDate: today,
            completed: false,
            completedAt: null,
            createdAt: new Date().toISOString(),
          });
        }
      }
    });
  }

  return {
    create, update, remove, toggle, reorder, assignTimeBlock,
    getToday, getInbox, getUpcoming, getCompleted, getByCategory,
    getForPlannerDate, seedRecurring,
  };
})();


/* ================================================================
   FocusTimer
   Pomodoro logic and session management.
   ================================================================ */
const FocusTimer = (() => {
  let timerId = null;
  let timeLeft = 0; // seconds
  let isWork = true;
  let isRunning = false;

  const $ = id => document.getElementById(id);

  function init() {
    const { workTime } = StateManager.get().settings.pomodoro;
    timeLeft = workTime * 60;
    updateDisplay();
  }

  function toggle() {
    if (isRunning) stop();
    else start();
  }

  function start() {
    if (isRunning) return;
    isRunning = true;
    timerId = setInterval(tick, 1000);
    UIManager.updateTimerBtn(true);
  }

  function stop() {
    isRunning = false;
    clearInterval(timerId);
    UIManager.updateTimerBtn(false);
  }

  function reset() {
    stop();
    const { workTime, breakTime } = StateManager.get().settings.pomodoro;
    isWork = true;
    timeLeft = workTime * 60;
    updateDisplay();
  }

  function tick() {
    if (timeLeft > 0) {
      timeLeft--;
      updateDisplay();
    } else {
      complete();
    }
  }

  function complete() {
    stop();
    const { workTime, breakTime } = StateManager.get().settings.pomodoro;

    if (isWork) {
      UIManager.showToast('Work session complete! Time for a break.');
      StateManager.set(s => s.settings.pomodoro.sessionsDone++);
      isWork = false;
      timeLeft = breakTime * 60;
    } else {
      UIManager.showToast('Break over! Back to focus.');
      isWork = true;
      timeLeft = workTime * 60;
    }

    updateDisplay();
    new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg').play().catch(() => { });
  }

  function updateDisplay() {
    const m = Math.floor(timeLeft / 60);
    const s = timeLeft % 60;
    const timeStr = `${m}:${s.toString().padStart(2, '0')}`;
    $('timer-display').textContent = timeStr;
    $('timer-label').textContent = isWork ? 'Focus Session' : 'Short Break';
    document.title = `${timeStr} - Focus`;
  }

  return { init, toggle, reset, isRunning: () => isRunning };
})();


/* ================================================================
   AuthManager
   Simple client-side gatekeeper.
   ================================================================ */
const AuthManager = (() => {
  const $ = id => document.getElementById(id);

  function formatEmail(input) {
    const val = input.trim();
    if (!val) return "";
    return val.includes('@') ? val : `${val.toLowerCase()}@planner.local`;
  }

  function init() {
    if (!auth) {
      console.warn('AuthManager: Auth service not available. Running in local mode.');
      showApp();
      return;
    }

    auth.onAuthStateChanged(user => {
      if (user) {
        showApp();
      } else {
        showLogin();
      }
    });

    $('btn-login').addEventListener('click', handleLogin);
    $('btn-register').addEventListener('click', handleRegister);
    $('btn-guest').addEventListener('click', () => {
      showApp();
    });

    ['auth-username', 'auth-password'].forEach(id => {
      const el = $(id);
      if (el) {
        el.addEventListener('keydown', e => {
          if (e.key === 'Enter') handleLogin();
        });
      }
    });
  }

  async function handleLogin() {
    const email = formatEmail($('auth-username').value);
    const pass = $('auth-password').value.trim();
    const err = $('auth-error');

    if (!email || !pass) {
      err.textContent = "Please enter username and password.";
      err.classList.add('visible');
      return;
    }

    try {
      err.classList.remove('visible');
      await auth.signInWithEmailAndPassword(email, pass);
    } catch (e) {
      err.textContent = "Login failed. Check your credentials.";
      err.classList.add('visible');
    }
  }

  async function handleRegister() {
    const email = formatEmail($('auth-username').value);
    const pass = $('auth-password').value.trim();
    const err = $('auth-error');

    if (!email || !pass) {
      err.textContent = "Please enter a username and password.";
      err.classList.add('visible');
      return;
    }

    if (pass.length < 6) {
      err.textContent = "Password must be at least 6 characters.";
      err.classList.add('visible');
      return;
    }

    try {
      err.classList.remove('visible');
      await auth.createUserWithEmailAndPassword(email, pass);
      UIManager.showToast('Account created!');
    } catch (e) {
      err.textContent = e.message;
      err.classList.add('visible');
    }
  }
      err.textContent = e.message;
      err.classList.add('visible');
    }
  }

  function showApp() {
    const authScreen = $('auth-screen');
    if (authScreen) authScreen.hidden = true;
    App.init();
  }

  function showLogin() {
    const authScreen = $('auth-screen');
    if (authScreen) authScreen.hidden = false;
  }

  async function logout() {
    if (auth) {
      await auth.signOut();
    }
    window.location.reload();
  }

  return { init, logout };
})();

/* ================================================================
   UIManager
   All DOM rendering. Reads from StateManager.
   ================================================================ */
const UIManager = (() => {

  /* ── Helpers ── */
  const $ = id => document.getElementById(id);
  const dateLabel = dateStr => {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    const today = TODAY_STR();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    if (dateStr === today) return '📅 Today';
    if (dateStr === tomorrowStr) return '📅 Tomorrow';
    const diff = Math.round((d - new Date(today + 'T00:00:00')) / 86400000);
    if (diff < 0) return `⚠ ${Math.abs(diff)}d overdue`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const isOverdue = dateStr =>
    dateStr && dateStr < TODAY_STR();

  /* ── Category helpers ── */
  function getCategoryColor(catId) {
    const cat = StateManager.get().categories.find(c => c.id === catId);
    return cat ? cat.color : '#999';
  }

  function getCategoryName(catId) {
    const cat = StateManager.get().categories.find(c => c.id === catId);
    return cat ? cat.name : '';
  }

  /* ── Render category nav ── */
  function renderCategoryNav() {
    const container = $('nav-categories');
    const { categories } = StateManager.get();
    container.innerHTML = categories.map(cat => `
      <div class="nav-category-row">
        <button class="nav-item" data-view="category:${cat.id}" tabindex="0"
                aria-label="Category: ${cat.name}">
          <span class="category-dot" style="background:${cat.color}"></span>
          <span>${cat.name}</span>
        </button>
        <button class="cat-delete-btn" data-id="${cat.id}" aria-label="Delete category">✕</button>
      </div>
    `).join('');

    // Wire delete
    container.querySelectorAll('.cat-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Delete this category and unassign all tasks?')) {
          TaskManager.removeCategory(btn.dataset.id);
          render();
        }
      });
    });
  }

  /* ── Update Timer UI ── */
  function updateTimerBtn(running) {
    $('btn-timer-toggle').textContent = running ? 'Pause' : 'Start Focus';
    $('btn-timer-toggle').classList.toggle('running', running);
  }

  /* ── Render sidebar analytics ── */
  function renderAnalytics() {
    const tasks = StateManager.get().tasks;
    const today = TODAY_STR();
    const completedToday = tasks.filter(
      t => t.completed && t.completedAt && t.completedAt.slice(0, 10) === today
    ).length;
    const totalToday = tasks.filter(
      t => t.dueDate === today || (t.completed && t.completedAt && t.completedAt.slice(0, 10) === today)
    ).length;
    const pct = totalToday > 0 ? Math.round((completedToday / totalToday) * 100) : 0;

    $('analytics-mini').innerHTML = `
      <div class="analytics-label">Today's Progress</div>
      <div class="analytics-stat">${completedToday}<span style="font-size:14px;opacity:.5">/${totalToday}</span></div>
      <div class="analytics-sub">tasks completed</div>
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width:${pct}%"></div>
      </div>
    `;
  }

  /* ── Render Habit Tracker ── */
  function renderHabits() {
    const container = $('habit-tracker');
    const { habits } = StateManager.get();
    const today = TODAY_STR();

    container.innerHTML = habits.map(habit => {
      const isDone = habit.completedDates.includes(today);
      return `
        <div class="habit-item ${isDone ? 'completed' : ''}" data-id="${habit.id}">
          <div class="habit-check">${isDone ? '✓' : ''}</div>
          <div class="habit-info">
            <div class="habit-name">${escapeHtml(habit.name)}</div>
            <div class="habit-streak">${habit.streak} day streak 🔥</div>
          </div>
        </div>
      `;
    }).join('');

    // Wire clicks
    container.querySelectorAll('.habit-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        TaskManager.toggleHabit(id, today);
        renderHabits();
        renderAnalytics();
      });
    });
  }

  /* ── Render badges ── */
  function renderBadges() {
    $('badge-today').textContent = TaskManager.getToday().length;
    $('badge-inbox').textContent = TaskManager.getInbox().length;
    $('badge-upcoming').textContent = TaskManager.getUpcoming().length;
  }

  /* ── Build a task item DOM element ── */
  function buildTaskItem(task, opts = {}) {
    const li = document.createElement('div');
    li.className = `task-item${task.completed ? ' completed' : ''}`;
    li.setAttribute('role', 'listitem');
    li.setAttribute('data-id', task.id);
    li.setAttribute('data-priority', task.priority);
    li.setAttribute('draggable', 'true');

    if (!task.completed && isOverdue(task.dueDate)) {
      li.classList.add('overdue-item');
    }

    const catName = getCategoryName(task.category);
    const catColor = getCategoryColor(task.category);
    const dueLabelText = dateLabel(task.dueDate);
    const dueCls = !task.completed && isOverdue(task.dueDate) ? 'overdue'
      : task.dueDate === TODAY_STR() ? 'due-today' : '';
    const tagsHtml = task.tags.length
      ? task.tags.map(t => `<span class="task-tag">#${t}</span>`).join('')
      : '';

    let subtaskHtml = '';
    if (task.subtasks && task.subtasks.length > 0) {
      const done = task.subtasks.filter(s => s.completed).length;
      const total = task.subtasks.length;
      const subPct = Math.round((done / total) * 100);
      subtaskHtml = `
        <div class="task-meta-subtask">${done}/${total} subtasks</div>
        <div class="subtask-progress-wrap">
          <div class="subtask-progress-fill" style="width:${subPct}%"></div>
        </div>
      `;
    }

    const timeLabel = task.startTime ? `<span class="task-meta-chip">🕒 ${task.startTime}</span>` : '';
    const durationLabel = task.duration ? `<span class="task-meta-chip">⏳ ${task.duration}m</span>` : '';

    li.innerHTML = `
      <div class="task-delete-bg">Delete</div>
      <div class="task-item-content">
        <button class="task-check" data-id="${task.id}" aria-label="Mark as ${task.completed ? 'incomplete' : 'complete'}" tabindex="0">
          ${task.completed ? '✓' : ''}
        </button>
        <div class="task-info">
          <div class="task-title">${escapeHtml(task.title)}</div>
          <div class="task-meta">
            ${dueLabelText ? `<span class="task-meta-chip ${dueCls}">${dueLabelText}</span>` : ''}
            ${timeLabel}
            ${durationLabel}
            ${task.timeBlock ? `<span class="task-meta-chip">⏱ ${cap(task.timeBlock)}</span>` : ''}
            ${catName ? `<span class="task-category-chip" style="background:${catColor}18;color:${catColor}">${catName}</span>` : ''}
            ${tagsHtml}
            ${task.recurring ? `<span class="task-meta-chip">↻</span>` : ''}
          </div>
          ${subtaskHtml}
        </div>
        <span class="task-drag-handle" aria-hidden="true">⠿</span>
      </div>
    `;

    // Swipe to delete logic
    let startX = 0;
    let currentX = 0;
    let isSwiping = false;
    const content = li.querySelector('.task-item-content');

    li.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX;
      isSwiping = true;
      content.style.transition = 'none';
    }, { passive: true });

    li.addEventListener('touchmove', e => {
      if (!isSwiping) return;
      currentX = e.touches[0].clientX;
      const diff = Math.min(0, currentX - startX);
      if (diff < -5) {
        content.style.transform = `translateX(${diff}px)`;
        // If swiped far enough, highlight delete
        if (diff < -70) li.classList.add('swipe-ready');
        else li.classList.remove('swipe-ready');
      }
    }, { passive: true });

    li.addEventListener('touchend', () => {
      isSwiping = false;
      content.style.transition = 'transform 0.3s var(--ease)';
      const diff = currentX - startX;

      if (diff < -100) {
        // Trigger delete
        content.style.transform = 'translateX(-100%)';
        setTimeout(() => {
          TaskManager.remove(task.id);
          render();
          showToast('Task deleted');
        }, 200);
      } else {
        // Reset
        content.style.transform = 'translateX(0)';
      }
    });

    return li;
  }

  /* ── Render task list ── */
  function renderTaskList(tasks, container, grouped = false) {
    container.innerHTML = '';

    const { priorityFilter, searchQuery } = StateManager.get().settings;

    let filtered = tasks;

    // Apply priority filter
    if (priorityFilter !== 'all') {
      filtered = filtered.filter(t => t.priority === priorityFilter);
    }

    // Apply search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      filtered = filtered.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (t.notes && t.notes.toLowerCase().includes(q)) ||
        t.tags.some(tag => tag.toLowerCase().includes(q))
      );
    }

    if (!filtered.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">◈</div>
          <div class="empty-state-title">${searchQuery ? 'No results found' : 'All clear'}</div>
          <div class="empty-state-sub">${searchQuery ? 'Try a different search term' : 'No tasks here. Add one to get started.'}</div>
        </div>`;
      return;
    }

    if (grouped) {
      const groups = { high: [], medium: [], low: [] };
      filtered.forEach(t => groups[t.priority].push(t));
      for (const [pri, items] of Object.entries(groups)) {
        if (!items.length) continue;
        const label = document.createElement('div');
        label.className = 'task-group-label';
        label.textContent = cap(pri) + ' priority';
        container.appendChild(label);
        items.forEach(t => container.appendChild(buildTaskItem(t)));
      }
    } else {
      filtered.forEach(t => container.appendChild(buildTaskItem(t)));
    }
  }

  /* ── Main render entry ── */
  function render() {
    const { activeView, priorityFilter, plannerDate } = StateManager.get().settings;

    renderBadges();
    renderAnalytics();
    renderHabits();
    renderCategoryNav();
    syncNavActive(activeView);
    populateCategorySelects();

    if (activeView === 'today') {
      renderTaskList(
        TaskManager.getToday().sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]),
        $('task-list'), false
      );
    } else if (activeView === 'inbox') {
      renderTaskList(
        TaskManager.getInbox().sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]),
        $('task-list'), false
      );
    } else if (activeView === 'upcoming') {
      const tasks = TaskManager.getUpcoming().sort((a, b) => {
        if (a.dueDate !== b.dueDate) return a.dueDate > b.dueDate ? 1 : -1;
        return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      });
      renderTaskList(tasks, $('task-list'), false);
    } else if (activeView === 'completed') {
      renderTaskList(TaskManager.getCompleted(), $('task-list'), false);
    } else if (activeView.startsWith('category:')) {
      const catId = activeView.split(':')[1];
      renderTaskList(
        TaskManager.getByCategory(catId).sort(
          (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
        ),
        $('task-list'), false
      );
    } else if (activeView === 'planner') {
      PlannerManager.render(plannerDate);
      return;
    }

    updateViewHeader();
    setDateDisplay();
    wireTaskListEvents();
    wireDragDrop($('task-list'));
  }

  /* ── Update view header title ── */
  function updateViewHeader() {
    const titles = {
      today: 'Today',
      inbox: 'Inbox',
      upcoming: 'Upcoming',
      completed: 'Completed',
    };
    const { activeView } = StateManager.get().settings;
    let title = titles[activeView] || '';
    if (activeView.startsWith('category:')) {
      const catId = activeView.split(':')[1];
      title = getCategoryName(catId) || 'Category';
    }
    const el = $('view-title-today');
    if (el) el.textContent = title;
  }

  /* ── Show date under title ── */
  function setDateDisplay() {
    const el = $('view-date');
    if (!el) return;
    el.textContent = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
    });
  }

  /* ── Highlight active nav ── */
  function syncNavActive(view) {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
  }

  /* ── Populate category selects ── */
  function populateCategorySelects() {
    const { categories } = StateManager.get();
    const opts = `<option value="">No category</option>` +
      categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    ['quick-category', 'edit-category'].forEach(id => {
      const el = $(id);
      if (el) el.innerHTML = opts;
    });
  }

  /* ── Wire task item events (delegation) ── */
  function wireTaskListEvents() {
    const container = $('task-list');
    if (!container) return;
    // remove old listener by cloning
    const fresh = container.cloneNode(true);
    container.parentNode.replaceChild(fresh, container);
    fresh.id = 'task-list';

    fresh.addEventListener('click', e => {
      const checkBtn = e.target.closest('.task-check');
      if (checkBtn) {
        e.stopPropagation();
        const id = checkBtn.dataset.id;
        const task = StateManager.get().tasks.find(t => t.id === id);

        // Celebration if completing high priority
        if (task && !task.completed && task.priority === 'high') {
          showCelebration();
        }

        TaskManager.toggle(id);
        UIManager.render();
        return;
      }
      const item = e.target.closest('.task-item');
      if (item) {
        openEditModal(item.dataset.id);
      }
    });

    fresh.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        const item = e.target.closest('.task-item');
        if (item) openEditModal(item.dataset.id);
      }
    });

    wireDragDrop(fresh);
  }

  /* ── Drag and drop reordering ── */
  let dragSrcId = null;

  function wireDragDrop(container) {
    if (!container) return;
    container.addEventListener('dragstart', e => {
      const item = e.target.closest('.task-item');
      if (!item) return;
      dragSrcId = item.dataset.id;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    container.addEventListener('dragend', e => {
      const item = e.target.closest('.task-item');
      if (item) item.classList.remove('dragging');
    });

    container.addEventListener('dragover', e => {
      e.preventDefault();
      const item = e.target.closest('.task-item');
      container.querySelectorAll('.task-item').forEach(i => i.classList.remove('drag-over'));
      if (item && item.dataset.id !== dragSrcId) item.classList.add('drag-over');
    });

    container.addEventListener('drop', e => {
      e.preventDefault();
      const item = e.target.closest('.task-item');
      container.querySelectorAll('.task-item').forEach(i => i.classList.remove('drag-over'));
      if (item && dragSrcId && item.dataset.id !== dragSrcId) {
        TaskManager.reorder(dragSrcId, item.dataset.id);
        UIManager.render();
      }
      dragSrcId = null;
    });
  }

  /* ── Switch view ── */
  function switchView(view) {
    StateManager.set(s => s.settings.activeView = view);

    // Toggle view sections
    document.querySelectorAll('.view').forEach(v => {
      v.removeAttribute('data-active');
    });

    if (view === 'planner') {
      $('view-planner').setAttribute('data-active', 'true');
    } else {
      $('view-today').setAttribute('data-active', 'true');
    }

    UIManager.render();
  }

  /* ── Open edit modal ── */
  function openEditModal(taskId) {
    const task = StateManager.get().tasks.find(t => t.id === taskId);
    if (!task) return;

    populateCategorySelects();

    $('edit-task-id').value = task.id;
    $('edit-title').value = task.title;
    $('edit-notes').value = task.notes || '';
    $('edit-priority').value = task.priority;
    $('edit-category').value = task.category || '';
    $('edit-due-date').value = task.dueDate || '';
    $('edit-start-time').value = task.startTime || '';
    $('edit-duration').value = task.duration || '';
    $('edit-time-block').value = task.timeBlock || '';
    $('edit-tags').value = task.tags.join(', ');
    $('edit-recurring').checked = !!task.recurring;

    renderSubtasks(task);

    $('modal-task').showModal();
    $('edit-title').focus();
  }

  function renderSubtasks(task) {
    const container = $('modal-subtask-list');
    container.innerHTML = (task.subtasks || []).map(sub => `
      <div class="subtask-item ${sub.completed ? 'completed' : ''}">
        <input type="checkbox" class="subtask-check" data-id="${sub.id}" ${sub.completed ? 'checked' : ''} />
        <span>${escapeHtml(sub.title)}</span>
        <button class="subtask-remove" data-id="${sub.id}">✕</button>
      </div>
    `).join('');

    // Wire subtask events
    container.querySelectorAll('.subtask-check').forEach(chk => {
      chk.addEventListener('change', () => {
        TaskManager.toggleSubtask(task.id, chk.dataset.id);
        renderSubtasks(StateManager.get().tasks.find(t => t.id === task.id));
        render(); // Update main view progress
      });
    });

    container.querySelectorAll('.subtask-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        TaskManager.removeSubtask(task.id, btn.dataset.id);
        renderSubtasks(StateManager.get().tasks.find(t => t.id === task.id));
        render();
      });
    });
  }

  function closeEditModal() {
    $('modal-task').close();
  }

  /* ── Celebration ── */
  function showCelebration() {
    const count = 20;
    const colors = ['#c8621a', '#2563eb', '#16a34a', '#d97706', '#8b5cf6'];
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'confetti';
      el.style.left = Math.random() * 100 + 'vw';
      el.style.top = '-10px';
      el.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
      el.style.width = Math.random() * 10 + 5 + 'px';
      el.style.height = el.style.width;
      el.style.borderRadius = '50%';
      document.body.appendChild(el);

      const animation = el.animate([
        { transform: 'translateY(0) rotate(0deg)', opacity: 1 },
        { transform: `translateY(100vh) rotate(${Math.random() * 360}deg)`, opacity: 0 }
      ], {
        duration: 1000 + Math.random() * 2000,
        easing: 'cubic-bezier(0, .9, .6, 1)'
      });
      animation.onfinish = () => el.remove();
    }
  }

  /* ── Escape HTML ── */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function cap(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : '';
  }

  /* ── Toggle theme ── */
  function toggleTheme() {
    const current = StateManager.get().settings.theme;
    const next = current === 'light' ? 'dark' : 'light';
    StateManager.set(s => s.settings.theme = next);
    document.documentElement.setAttribute('data-theme', next);
    $('btn-theme').textContent = next === 'dark' ? '☀' : '☽';
  }

  /* ── Toast notification ── */
  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  /* ── Quick-add bar ── */
  function showQuickAdd() {
    populateCategorySelects();
    $('quick-add-bar').classList.add('visible');
    $('quick-add-input').focus();
  }

  function hideQuickAdd() {
    $('quick-add-bar').classList.remove('visible');
    $('quick-add-input').value = '';
    $('quick-priority').value = 'medium';
    $('quick-date').value = '';
  }

  return {
    render, switchView, openEditModal, closeEditModal,
    showQuickAdd, hideQuickAdd, toggleTheme, showToast,
    wireTaskListEvents, populateCategorySelects,
    buildTaskItem, escapeHtml, updateTimerBtn,
  };
})();


/* ================================================================
   PlannerManager
   Time-blocking planner view.
   ================================================================ */
const PlannerManager = (() => {
  const $ = id => document.getElementById(id);

  function render(dateStr) {
    const labelEl = $('planner-date-label');
    if (labelEl) {
      labelEl.textContent = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
    }

    const tasks = TaskManager.getForPlannerDate(dateStr);
    const blocks = $('planner-blocks');
    const unscheduledList = $('planner-unscheduled-list');

    blocks.innerHTML = '';

    TIME_BLOCKS.forEach(block => {
      const blockTasks = tasks.filter(t => t.timeBlock === block.id);
      const card = document.createElement('div');
      card.className = `time-block-card block-${block.id}`;
      card.setAttribute('data-block', block.id);
      card.innerHTML = `
        <div class="time-block-header">
          <span class="time-block-accent"></span>
          <span class="time-block-name">${block.label}</span>
          <span class="time-block-range">${block.range}</span>
        </div>
        <div class="time-block-tasks" id="block-tasks-${block.id}" data-block="${block.id}">
          <div class="time-block-drop-hint">Drop task here</div>
          ${blockTasks.map(t => buildPlannerChip(t)).join('')}
        </div>
      `;
      blocks.appendChild(card);
    });

    // Unscheduled tasks (today tasks with no timeBlock)
    const unscheduled = tasks.filter(t => !t.timeBlock);
    unscheduledList.innerHTML = unscheduled.length
      ? unscheduled.map(t => buildPlannerChip(t)).join('')
      : `<div style="font-size:12px;color:var(--text-tertiary);padding:12px;text-align:center">No unscheduled tasks</div>`;

    wirePlannerDragDrop();
    wirePlannerChipClicks();
  }

  function buildPlannerChip(task) {
    const colorMap = { high: '#dc2626', medium: '#d97706', low: '#2563eb' };
    return `
      <div class="planner-task-chip" data-id="${task.id}" draggable="true">
        <span class="priority-dot" data-priority="${task.priority}" style="background:${colorMap[task.priority]}"></span>
        <span>${UIManager.escapeHtml(task.title)}</span>
      </div>
    `;
  }

  function wirePlannerDragDrop() {
    let dragId = null;

    const chips = document.querySelectorAll('.planner-task-chip');
    chips.forEach(chip => {
      chip.addEventListener('dragstart', e => {
        dragId = chip.dataset.id;
        e.dataTransfer.effectAllowed = 'move';
      });
    });

    const dropZones = document.querySelectorAll('.time-block-tasks');
    dropZones.forEach(zone => {
      zone.addEventListener('dragover', e => {
        e.preventDefault();
        zone.classList.add('drag-target');
      });

      zone.addEventListener('dragleave', () => {
        zone.classList.remove('drag-target');
      });

      zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drag-target');
        if (!dragId) return;
        const block = zone.dataset.block;
        TaskManager.assignTimeBlock(dragId, block);
        UIManager.showToast(`Moved to ${block}`);
        render(StateManager.get().settings.plannerDate);
        dragId = null;
      });
    });

    // Drop on unscheduled
    const unscheduled = $('planner-unscheduled-list');
    if (unscheduled) {
      unscheduled.addEventListener('dragover', e => e.preventDefault());
      unscheduled.addEventListener('drop', e => {
        e.preventDefault();
        if (!dragId) return;
        TaskManager.assignTimeBlock(dragId, '');
        UIManager.showToast('Moved to unscheduled');
        render(StateManager.get().settings.plannerDate);
        dragId = null;
      });
    }
  }

  function wirePlannerChipClicks() {
    document.querySelectorAll('.planner-task-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        UIManager.openEditModal(chip.dataset.id);
      });
    });
  }

  function navigate(delta) {
    const { plannerDate } = StateManager.get().settings;
    const d = new Date(plannerDate + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    const next = d.toISOString().slice(0, 10);
    StateManager.set(s => s.settings.plannerDate = next);
    render(next);
  }

  function goToday() {
    const today = TODAY_STR();
    StateManager.set(s => s.settings.plannerDate = today);
    render(today);
  }

  return { render, navigate, goToday };
})();


/* ================================================================
   App
   Bootstrap and event wiring.
   ================================================================ */
const App = (() => {
  const $ = id => document.getElementById(id);

  async function init() {
    await StateManager.init();

    // If state failed to load (e.g. no user yet), don't boot UI fully
    if (!StateManager.get()) return;

    // Seed recurring tasks
    TaskManager.seedRecurring();

    // Apply saved theme
    const theme = StateManager.get().settings.theme;
    document.documentElement.setAttribute('data-theme', theme);
    $('btn-theme').textContent = theme === 'dark' ? '☀' : '☽';

    // Initial render
    UIManager.render();

    $('btn-logout').addEventListener('click', AuthManager.logout);

    wireNavEvents();
    wireQuickAdd();
    wireModal();
    wirePlannerNav();
    wireGlobalKeys();
    wireSidebarToggle();
    wireToolbar();
    wireFilterEvents();
    wireSearch();
    wireHabitEvents();
    wireSubtaskEvents();
    wireTimerEvents();
    wireCategoryEvents();
    wireShortcutsModal();

    FocusTimer.init();
  }

  /* ── Search ── */
  function wireSearch() {
    const input = $('sidebar-search-input');
    input.addEventListener('input', e => {
      StateManager.set(s => s.settings.searchQuery = e.target.value);
      UIManager.render();
    });
  }

  /* ── Focus Timer ── */
  function wireTimerEvents() {
    $('btn-timer-toggle').addEventListener('click', () => FocusTimer.toggle());
    $('btn-timer-reset').addEventListener('click', () => FocusTimer.reset());
  }

  /* ── Category Mgmt ── */
  function wireCategoryEvents() {
    const addCat = () => {
      const name = $('cat-add-input').value.trim();
      if (!name) return;
      const color = $('cat-add-color').value;
      TaskManager.addCategory(name, color);
      $('cat-add-input').value = '';
      UIManager.render();
    };
    $('cat-add-btn').addEventListener('click', addCat);
    $('cat-add-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') addCat();
    });
  }

  /* ── Shortcuts Modal ── */
  function wireShortcutsModal() {
    $('btn-shortcuts').addEventListener('click', () => $('modal-shortcuts').showModal());
    $('modal-shortcuts-close').addEventListener('click', () => $('modal-shortcuts').close());
    $('modal-shortcuts').addEventListener('click', e => {
      if (e.target === $('modal-shortcuts')) $('modal-shortcuts').close();
    });
  }

  /* ── Habits ── */
  function wireHabitEvents() {
    const addHabit = () => {
      const name = $('habit-add-input').value.trim();
      if (!name) return;
      TaskManager.createHabit(name);
      $('habit-add-input').value = '';
      UIManager.render();
    };
    $('habit-add-btn').addEventListener('click', addHabit);
    $('habit-add-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') addHabit();
    });
  }

  /* ── Subtasks ── */
  function wireSubtaskEvents() {
    const addSub = () => {
      const taskId = $('edit-task-id').value;
      const title = $('subtask-add-input').value.trim();
      if (!taskId || !title) return;
      TaskManager.addSubtask(taskId, title);
      $('subtask-add-input').value = '';
      UIManager.renderSubtasks(StateManager.get().tasks.find(t => t.id === taskId));
      UIManager.render();
    };
    $('subtask-add-btn').addEventListener('click', addSub);
    $('subtask-add-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSub();
      }
    });
  }

  /* ── Navigation ── */
  function wireNavEvents() {
    document.addEventListener('click', e => {
      const navItem = e.target.closest('.nav-item[data-view]');
      if (!navItem) return;
      UIManager.switchView(navItem.dataset.view);
      // Close mobile sidebar
      closeMobileSidebar();
    });
  }

  /* ── Quick Add ── */
  function wireQuickAdd() {
    $('btn-add-task').addEventListener('click', () => UIManager.showQuickAdd());
    $('btn-add-mobile').addEventListener('click', () => UIManager.showQuickAdd());
    $('btn-cancel-quick').addEventListener('click', () => UIManager.hideQuickAdd());
    $('btn-save-quick').addEventListener('click', saveQuickTask);

    $('quick-add-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') saveQuickTask();
      if (e.key === 'Escape') UIManager.hideQuickAdd();
    });
  }

  function saveQuickTask() {
    const title = $('quick-add-input').value.trim();
    if (!title) {
      $('quick-add-input').focus();
      return;
    }
    const { activeView } = StateManager.get().settings;
    const isToday = (activeView === 'today');

    TaskManager.create({
      title,
      priority: $('quick-priority').value,
      dueDate: $('quick-date').value || (isToday ? TODAY_STR() : ''),
      category: $('quick-category').value,
    });

    UIManager.hideQuickAdd();
    UIManager.render();
    UIManager.showToast('Task added ✓');
  }

  /* ── Edit Modal ── */
  function wireModal() {
    $('modal-close').addEventListener('click', () => UIManager.closeEditModal());
    $('btn-cancel-edit').addEventListener('click', () => UIManager.closeEditModal());

    $('btn-save-edit').addEventListener('click', () => {
      const id = $('edit-task-id').value;
      const title = $('edit-title').value.trim();
      if (!title) { $('edit-title').focus(); return; }

      const rawTags = $('edit-tags').value;
      const tags = rawTags.split(',').map(t => t.trim()).filter(Boolean);

      TaskManager.update(id, {
        title,
        notes: $('edit-notes').value.trim(),
        priority: $('edit-priority').value,
        category: $('edit-category').value,
        dueDate: $('edit-due-date').value,
        startTime: $('edit-start-time').value,
        duration: $('edit-duration').value,
        timeBlock: $('edit-time-block').value,
        tags,
        recurring: $('edit-recurring').checked,
      });

      UIManager.closeEditModal();
      UIManager.render();
      UIManager.showToast('Task saved ✓');
    });

    $('btn-delete-task').addEventListener('click', () => {
      const id = $('edit-task-id').value;
      if (!id) return;
      TaskManager.remove(id);
      UIManager.closeEditModal();
      UIManager.render();
      UIManager.showToast('Task deleted');
    });

    // Close on backdrop click
    $('modal-task').addEventListener('click', e => {
      if (e.target === $('modal-task')) UIManager.closeEditModal();
    });

    // Keyboard save in modal
    $('modal-task').addEventListener('keydown', e => {
      if (e.key === 'Escape') UIManager.closeEditModal();
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        $('btn-save-edit').click();
      }
    });
  }

  /* ── Planner navigation ── */
  function wirePlannerNav() {
    $('planner-prev').addEventListener('click', () => PlannerManager.navigate(-1));
    $('planner-next').addEventListener('click', () => PlannerManager.navigate(1));
    $('planner-today-btn').addEventListener('click', () => PlannerManager.goToday());
  }

  /* ── Global keyboard shortcuts ── */
  function wireGlobalKeys() {
    document.addEventListener('keydown', e => {
      const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);

      // Focus Search (/)
      if (e.key === '/' && !isInput) {
        e.preventDefault();
        $('sidebar-search-input').focus();
      }

      // Show Shortcuts (?)
      if (e.key === '?' && !isInput) {
        e.preventDefault();
        $('modal-shortcuts').showModal();
      }

      // New Task (n)
      if (e.key === 'n' && !isInput) {
        e.preventDefault();
        UIManager.showQuickAdd();
      }

      // View Switching
      if (!isInput) {
        const views = { 't': 'today', 'i': 'inbox', 'u': 'upcoming', 'p': 'planner', 'c': 'completed' };
        if (views[e.key]) {
          e.preventDefault();
          UIManager.switchView(views[e.key]);
        }
      }
    });
  }

  /* ── Mobile sidebar toggle ── */
  function wireSidebarToggle() {
    $('btn-sidebar-toggle').addEventListener('click', () => {
      $('sidebar').classList.toggle('open');
      $('sidebar-overlay').classList.toggle('visible');
    });

    $('sidebar-overlay').addEventListener('click', closeMobileSidebar);
  }

  function closeMobileSidebar() {
    $('sidebar').classList.remove('open');
    $('sidebar-overlay').classList.remove('visible');
  }

  /* ── Toolbar: theme, export, import ── */
  function wireToolbar() {
    $('btn-theme').addEventListener('click', () => UIManager.toggleTheme());

    $('btn-export').addEventListener('click', () => {
      const data = JSON.stringify(StateManager.get(), null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `focus-tasks-${TODAY_STR()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      UIManager.showToast('Tasks exported!');
    });

    $('btn-import-trigger').addEventListener('click', () => $('btn-import').click());

    $('btn-import').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const imported = JSON.parse(ev.target.result);
          if (!imported.tasks || !imported.categories) {
            UIManager.showToast('Invalid file format');
            return;
          }
          StorageService.save(imported);
          StateManager.init();
          UIManager.render();
          UIManager.showToast(`Imported ${imported.tasks.length} tasks ✓`);
        } catch (err) {
          UIManager.showToast('Failed to import: invalid JSON');
        }
      };
      reader.readAsText(file);
      e.target.value = ''; // reset so same file can be re-imported
    });
  }

  /* ── Priority filter ── */
  function wireFilterEvents() {
    $('filter-priority').addEventListener('change', e => {
      StateManager.set(s => s.settings.priorityFilter = e.target.value);
      UIManager.render();
    });
  }

  return { init };
})();


/* ================================================================
   BOOTSTRAP
   ================================================================ */
document.addEventListener('DOMContentLoaded', () => AuthManager.init());
