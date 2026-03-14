/**
 * UI Components
 * Reusable UI elements
 */

// Toast notifications
export const Toast = {
  container: null,

  init() {
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
  },

  show(message, type = 'info', duration = 4000) {
    this.init();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${this.getIcon(type)}</span>
      <span class="toast-message">${escapeHtml(message)}</span>
      <button class="toast-close">&times;</button>
    `;

    toast.querySelector('.toast-close').addEventListener('click', () => {
      toast.remove();
    });

    this.container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    // Auto dismiss
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  getIcon(type) {
    const icons = {
      success: '✓',
      error: '✕',
      warning: '⚠',
      info: 'ℹ',
    };
    return icons[type] || icons.info;
  },
};

// Modal dialog
export class Modal {
  constructor(element) {
    this.element = typeof element === 'string' ? document.getElementById(element) : element;
    this.bindEvents();
  }

  bindEvents() {
    this.element?.addEventListener('click', (e) => {
      if (e.target === this.element || e.target.classList.contains('modal-close')) {
        this.close();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) {
        this.close();
      }
    });
  }

  open() {
    this.element?.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  close() {
    this.element?.classList.remove('active');
    document.body.style.overflow = '';
  }

  isOpen() {
    return this.element?.classList.contains('active');
  }

  setContent(html) {
    const body = this.element?.querySelector('.modal-body');
    if (body) body.innerHTML = html;
  }
}

// Tooltip
export class Tooltip {
  static init() {
    document.addEventListener('mouseover', (e) => {
      const trigger = e.target.closest('[data-tooltip]');
      if (!trigger) return;

      const text = trigger.dataset.tooltip;
      const tooltip = document.createElement('div');
      tooltip.className = 'tooltip';
      tooltip.textContent = text;
      document.body.appendChild(tooltip);

      const rect = trigger.getBoundingClientRect();
      tooltip.style.left = `${rect.left + rect.width / 2 - tooltip.offsetWidth / 2}px`;
      tooltip.style.top = `${rect.top - tooltip.offsetHeight - 8}px`;

      trigger._tooltip = tooltip;
    });

    document.addEventListener('mouseout', (e) => {
      const trigger = e.target.closest('[data-tooltip]');
      if (trigger && trigger._tooltip) {
        trigger._tooltip.remove();
        trigger._tooltip = null;
      }
    });
  }
}

// Loading overlay
export const Loading = {
  show(message = 'Loading...') {
    let overlay = document.getElementById('global-loading');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'global-loading';
      overlay.className = 'loading-overlay';
      overlay.innerHTML = `
        <div class="spinner"></div>
        <p class="loading-message"></p>
      `;
      document.body.appendChild(overlay);
    }
    overlay.querySelector('.loading-message').textContent = message;
    overlay.classList.add('active');
  },

  hide() {
    const overlay = document.getElementById('global-loading');
    overlay?.classList.remove('active');
  },
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}