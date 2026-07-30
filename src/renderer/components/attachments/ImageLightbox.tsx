import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt = '', onClose }: ImageLightboxProps) {
  // Defer close so the same click/pointer that dismissed the overlay
  // cannot fall through onto the thumbnail and reopen it.
  const close = useCallback(() => {
    window.setTimeout(() => onClose(), 0);
  }, [onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="titlebar-no-drag fixed inset-0 z-[10000] flex items-center justify-center bg-black/90 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'Image preview'}
      onMouseDown={(e) => {
        // Only close when pressing the backdrop itself (not the image/button)
        if (e.target === e.currentTarget) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          close();
        }}
        onClick={(e) => {
          // Prevent residual click from reaching elements underneath
          e.preventDefault();
          e.stopPropagation();
        }}
        className="titlebar-no-drag absolute top-14 right-4 z-[10001] flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 transition-colors pointer-events-auto"
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>
      <img
        src={src}
        alt={alt}
        className="relative z-0 max-h-full max-w-full object-contain pointer-events-none select-none"
        draggable={false}
      />
    </div>,
    document.body
  );
}
