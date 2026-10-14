/**
 * In-browser dynamic DOM mutation and SPA route tracker (Brick 32).
 * Observes meaningful semantic main-document mutations and client-side route changes.
 *
 * Strict Privacy & Security Invariants:
 * - NEVER records or exposes input text values, password values, textarea contents, file paths,
 *   cookies, localStorage, sessionStorage, or hidden tokens.
 * - Only maintains numeric revision counters and monotonic timestamps.
 * - Main document only (no iframes, no shadow roots).
 * - Passive, non-blocking observation (no mutation event flood over IPC).
 */

export const RELEVANT_ATTRIBUTES = Object.freeze([
  'role',
  'href',
  'target',
  'disabled',
  'hidden',
  'aria-hidden',
  'aria-label',
  'aria-labelledby',
  'aria-disabled',
  'aria-expanded',
  'placeholder',
  'type',
  'name',
  'action',
  'for',
  'checked',
  'selected',
  'style',
  'class'
]);

export const DYNAMIC_TRACKER_SCRIPT = `(() => {
  if (typeof window === 'undefined') return;

  if (window.__JARVIS_DYNAMIC_TRACKER__) {
    if (typeof window.__JARVIS_DYNAMIC_TRACKER__.ensureObserver === 'function') {
      window.__JARVIS_DYNAMIC_TRACKER__.ensureObserver();
    }
    return;
  }

  const RELEVANT_TAGS = new Set([
    'A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'FORM',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LABEL', 'OPTION'
  ]);

  const RELEVANT_ROLES = new Set([
    'button', 'link', 'heading', 'checkbox', 'radio', 'textbox',
    'combobox', 'listbox', 'option', 'menuitem', 'tab', 'alert', 'status', 'dialog'
  ]);

  const RELEVANT_ATTRS = new Set([
    'role', 'href', 'target', 'disabled', 'hidden', 'aria-hidden',
    'aria-label', 'aria-labelledby', 'aria-disabled', 'aria-expanded',
    'placeholder', 'type', 'name', 'action', 'for', 'checked', 'selected',
    'style', 'class'
  ]);

  function isNodeSensitive(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = (node.tagName || '').toUpperCase();
    if (tag === 'INPUT') {
      const type = (node.type || '').toLowerCase();
      if (type === 'password' || type === 'hidden') return true;
    }
    return false;
  }

  function isNodeRelevant(node) {
    if (!node) return false;
    // Text node
    if (node.nodeType === 3) {
      const parent = node.parentElement;
      if (!parent || isNodeSensitive(parent)) return false;
      const tag = (parent.tagName || '').toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return false;
      if (RELEVANT_TAGS.has(tag)) return true;
      const role = (parent.getAttribute && parent.getAttribute('role') || '').toLowerCase();
      if (role && RELEVANT_ROLES.has(role)) return true;
      return false;
    }
    // Element node
    if (node.nodeType === 1) {
      if (isNodeSensitive(node)) return false;
      const tag = (node.tagName || '').toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'HEAD') return false;
      if (RELEVANT_TAGS.has(tag)) return true;
      const role = (node.getAttribute && node.getAttribute('role') || '').toLowerCase();
      if (role && RELEVANT_ROLES.has(role)) return true;
      if (typeof node.querySelector === 'function') {
        try {
          if (node.querySelector('a, button, input:not([type="hidden"]):not([type="password"]), textarea, select, form, h1, h2, h3, h4, h5, h6, [role]')) {
            return true;
          }
        } catch {}
      }
    }
    return false;
  }

  const tracker = {
    semanticRevision: 1,
    spaRouteVersion: 1,
    lastRelevantMutationTime: Date.now(),
    lastUrl: (window.location && window.location.href) || 'about:blank',
    spaRouteChanged: false,
    observer: null,
    observerInstalled: false,
    destroyed: false
  };

  function bumpRevision() {
    tracker.semanticRevision++;
    tracker.lastRelevantMutationTime = Date.now();
  }

  function handleMutations(mutations) {
    if (tracker.destroyed) return;
    let changed = false;
    for (const m of mutations) {
      if (m.type === 'childList') {
        if (m.addedNodes && m.addedNodes.length > 0) {
          for (let i = 0; i < m.addedNodes.length; i++) {
            if (isNodeRelevant(m.addedNodes[i])) { changed = true; break; }
          }
        }
        if (changed) break;
        if (m.removedNodes && m.removedNodes.length > 0) {
          for (let i = 0; i < m.removedNodes.length; i++) {
            if (isNodeRelevant(m.removedNodes[i])) { changed = true; break; }
          }
        }
        if (changed) break;
      } else if (m.type === 'attributes') {
        const attrName = (m.attributeName || '').toLowerCase();
        if (RELEVANT_ATTRS.has(attrName)) {
          if (!isNodeSensitive(m.target) && isNodeRelevant(m.target)) {
            changed = true;
            break;
          }
        }
      } else if (m.type === 'characterData') {
        if (isNodeRelevant(m.target)) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      bumpRevision();
    }
  }

  tracker.ensureObserver = function () {
    if (tracker.destroyed) return;
    if (!tracker.observer && typeof MutationObserver !== 'undefined') {
      try {
        const observer = new MutationObserver(handleMutations);
        const target = (typeof document !== 'undefined' && document)
          ? (document.documentElement || document.body || document)
          : null;
        if (target && typeof observer.observe === 'function') {
          observer.observe(target, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [
              'role', 'href', 'target', 'disabled', 'hidden', 'aria-hidden',
              'aria-label', 'aria-labelledby', 'aria-disabled', 'aria-expanded',
              'placeholder', 'type', 'name', 'action', 'for', 'checked', 'selected',
              'style', 'class'
            ],
            characterData: true
          });
          tracker.observer = observer;
          tracker.observerInstalled = true;
        }
      } catch {}
    }
  };

  try {
    tracker.ensureObserver();
  } catch {}

  function handleUrlChange(newUrl) {
    if (tracker.destroyed) return;
    if (newUrl && newUrl !== tracker.lastUrl) {
      tracker.lastUrl = newUrl;
      tracker.spaRouteVersion++;
      tracker.spaRouteChanged = true;
      bumpRevision();
    }
  }

  try {
    if (typeof history !== 'undefined') {
      const origPush = history.pushState;
      if (typeof origPush === 'function') {
        history.pushState = function (...args) {
          const ret = origPush.apply(this, args);
          try { handleUrlChange(window.location.href); } catch {}
          return ret;
        };
      }

      const origReplace = history.replaceState;
      if (typeof origReplace === 'function') {
        history.replaceState = function (...args) {
          const ret = origReplace.apply(this, args);
          try { handleUrlChange(window.location.href); } catch {}
          return ret;
        };
      }
    }

    if (typeof window.addEventListener === 'function') {
      window.addEventListener('popstate', () => {
        try { handleUrlChange(window.location.href); } catch {}
      });
      window.addEventListener('hashchange', () => {
        try { handleUrlChange(window.location.href); } catch {}
      });
    }
  } catch {}

  tracker.destroy = function () {
    tracker.destroyed = true;
    if (tracker.observer && typeof tracker.observer.disconnect === 'function') {
      tracker.observer.disconnect();
      tracker.observer = null;
    }
    tracker.observerInstalled = false;
  };

  window.__JARVIS_DYNAMIC_TRACKER__ = tracker;
})();`;
