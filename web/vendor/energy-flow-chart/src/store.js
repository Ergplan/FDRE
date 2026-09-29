// Linked state shared by charts, cards, legends and anything else that wants to
// stay in sync. Pass the same store to several components to link them.
//
// state = {
//   range:     [t0, t1]          visible time window (epoch-ms, wall-clock UTC)
//   hover:     number | null     hovered sample index
//   hidden:    Set<string>       series keys toggled off
//   highlight: Set<string>|null  series keys emphasised (others dim)
// }

export function createStore(initial = {}) {
  let state = {
    range: null,
    hover: null,
    hidden: new Set(),
    highlight: null,
    ...initial,
  };
  const listeners = new Set();

  const store = {
    get: () => state,
    /** Shallow-merge a patch and notify listeners with the list of changed keys. */
    set(patch) {
      const changed = [];
      for (const [k, v] of Object.entries(patch)) {
        if (!same(state[k], v)) changed.push(k);
      }
      if (!changed.length) return;
      state = { ...state, ...patch };
      for (const fn of [...listeners]) fn(state, changed);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    toggle(key) {
      const hidden = new Set(state.hidden);
      hidden.has(key) ? hidden.delete(key) : hidden.add(key);
      store.set({ hidden });
    },
    setHighlight(keys) {
      store.set({ highlight: keys && keys.length ? new Set(keys) : null });
    },
  };
  return store;
}

function same(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((v) => b.has(v));
  return false;
}
