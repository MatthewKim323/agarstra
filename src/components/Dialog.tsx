import { useEffect, useRef, type ReactNode } from "react";
import { Square, X } from "lucide-react";
export const EMERGENCY_STOP_EVENT = "nerve:emergency-stop";
export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    el?.showModal();
    return () => {
      el?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? "wide" : ""}`}
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-head">
        <h2 id="dialog-title">{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
      <button
        className="dialog-emergency stop-button"
        data-scan-id="dialog-emergency-stop"
        data-camera-scan="emergency-stop"
        aria-label="Emergency stop"
        onClick={() => {
          window.dispatchEvent(new Event(EMERGENCY_STOP_EVENT));
          onClose();
        }}
      >
        <Square size={13} /> Emergency stop
      </button>
    </dialog>
  );
}
