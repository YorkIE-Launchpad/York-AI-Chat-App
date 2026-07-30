import { useState, type ReactNode, type KeyboardEvent } from 'react';
import { ImageLightbox } from './ImageLightbox';

interface AttachmentImageThumbProps {
  src: string;
  alt?: string;
  /** Composer grid fills the cell; message history uses a fixed square. */
  variant?: 'grid' | 'fixed';
  className?: string;
  removeButton?: ReactNode;
}

export function AttachmentImageThumb({
  src,
  alt = '',
  variant = 'fixed',
  className = '',
  removeButton,
}: AttachmentImageThumbProps) {
  const [open, setOpen] = useState(false);

  const openLightbox = () => setOpen(true);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openLightbox();
    }
  };

  const imageClass =
    variant === 'grid'
      ? 'w-full aspect-square object-cover rounded-lg border border-border block'
      : 'h-24 w-24 object-cover rounded-lg border border-border block';

  return (
    <>
      <div className={`relative group inline-block ${className}`}>
        <div
          role="button"
          tabIndex={0}
          onClick={openLightbox}
          onKeyDown={onKeyDown}
          className="cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg"
          aria-label={alt ? `Open ${alt}` : 'Open image preview'}
        >
          <img src={src} alt={alt} className={imageClass} />
        </div>
        {removeButton}
      </div>
      {open && <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}
