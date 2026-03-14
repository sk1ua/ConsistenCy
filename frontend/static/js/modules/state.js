/**
 * State Manager
 * Simple reactive state management
 */

export class StateManager {
  constructor() {
    this.state = new Map();
    this.listeners = new Map();
  }

  get(key) {
    return this.state.get(key);
  }

  set(key, value) {
    const oldValue = this.state.get(key);
    this.state.set(key, value);
    
    if (oldValue !== value) {
      this.notify(key, value, oldValue);
    }
  }

  subscribe(key, callback) {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key).add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(key)?.delete(callback);
    };
  }

  notify(key, newValue, oldValue) {
    this.listeners.get(key)?.forEach(cb => {
      try {
        cb(newValue, oldValue);
      } catch (err) {
        console.error('State listener error:', err);
      }
    });
  }
}