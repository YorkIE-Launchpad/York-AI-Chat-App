import { useState, type ReactNode, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { ImageLightbox } from './ImageLightbox';
import type { ImageDownloadSource } from '../../utils/save-image';
import { saveImageToDisk } from '../../utils/save-image';

interface AttachmentImageThumbProps {
  src: string;
  alt?: string;
  /** Composer grid fills the cell; fixed = small user thumb; message = larger chat image. */
  variant?: 'grid' | 'fixed' | 'message';
  className?: string;
  removeButton?: ReactNode;
  download?: ImageDownloadSource;
}

export function AttachmentImageThumb({
  src,
  alt = '',
  variant = 'fixed',
  className = '',
  removeButton,
  download,
}: AttachmentImageThumbProps) {
  const { t } = useTranslation();
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
      : variant === 'message'
        ? 'max-h-80 max-w-[min(100%,18rem)] sm:max-w-sm md:max-w-md w-auto h-auto object-contain rounded-xl border border-border block'
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
        {download && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void saveImageToDisk(download);
            }}
            className="absolute bottom-1 left-1 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/70"
            title={t('common.downloadImage')}
            aria-label={t('common.downloadImage')}
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        )}
        {removeButton}
      </div>
      {open && (
        <ImageLightbox
          src={src}
          alt={alt}
          download={download}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
