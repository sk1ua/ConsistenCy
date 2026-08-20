import React, { createContext, useContext, useState, useCallback } from "react";
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from "lucide-react";
import { IconButton } from "./IconButton";

export type ToastType = "info" | "success" | "warning" | "error";

export interface ToastMessage {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
  duration?: number;
}

interface ToastContextType {
  toast: (options: Omit<ToastMessage, "id">) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((options: Omit<ToastMessage, "id">) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const duration = options.duration ?? 4000;
    const newToast: ToastMessage = { ...options, id };

    setToasts(prev => [...prev, newToast]);

    if (duration > 0) {
      setTimeout(() => {
        removeToast(id);
      }, duration);
    }
  }, [removeToast]);

  const success = useCallback((title: string, description?: string) => {
    addToast({ type: "success", title, description });
  }, [addToast]);

  const error = useCallback((title: string, description?: string) => {
    addToast({ type: "error", title, description, duration: 6000 });
  }, [addToast]);

  const warning = useCallback((title: string, description?: string) => {
    addToast({ type: "warning", title, description });
  }, [addToast]);

  const info = useCallback((title: string, description?: string) => {
    addToast({ type: "info", title, description });
  }, [addToast]);

  const getIcon = (type: ToastType) => {
    switch (type) {
      case "success":
        return <CheckCircle2 size={16} color="var(--success)" />;
      case "error":
        return <AlertCircle size={16} color="var(--danger)" />;
      case "warning":
        return <AlertTriangle size={16} color="var(--warning)" />;
      case "info":
      default:
        return <Info size={16} color="var(--primary)" />;
    }
  };

  return (
    <ToastContext.Provider value={{ toast: addToast, success, error, warning, info }}>
      {children}
      <div className="ds-toast-container" role="status" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className="ds-toast">
            <div style={{ flexShrink: 0, marginTop: "1px" }}>{getIcon(t.type)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: "13px" }}>{t.title}</div>
              {t.description && (
                <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "2px" }}>
                  {t.description}
                </div>
              )}
            </div>
            <IconButton
              icon={<X size={14} />}
              label="Dismiss"
              size="sm"
              onClick={() => removeToast(t.id)}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export function useToast(): ToastContextType {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
