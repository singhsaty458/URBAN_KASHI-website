import { useId } from 'react';
import '../brand.css';

export interface BrandProps {
  compact?: boolean;
  className?: string;
}

/** Original vector interpretation of the supplied mark, not a traced restoration. */
export function Brand({ compact = false, className = '' }: BrandProps) {
  const goldId = `uk-brand-gold-${useId().replace(/:/g, '')}`;

  return (
    <span
      className={`uk-brand${compact ? ' uk-brand--compact' : ''}${className ? ` ${className}` : ''}`}
      role="img"
      aria-label="अर्बन काशी — URBAN KASHI"
    >
      <span className="uk-brand__perspective" aria-hidden="true">
        <svg
          className="uk-brand__trishul"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 120 160"
          width="36"
          height="48"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient id={goldId} x1="12" y1="20" x2="108" y2="145" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#b99145" />
              <stop offset="0.38" stopColor="#efd595" />
              <stop offset="0.68" stopColor="#d4ae63" />
              <stop offset="1" stopColor="#b99145" />
            </linearGradient>
          </defs>
          <g fill={`url(#${goldId})`}>
            {/* Reference-inspired silhouette: central blade, swept prongs and ornamental base. */}
            <path d="M60 3C57 31 52 51 38 70C47 79 54 93 54 105C54 118 40 115 38 103L38 97C32 98 29 102 28 108C20 106 19 99 22 88C26 72 33 55 31 39C30 29 26 20 22 15C25 41 12 61 6 81C0 103 4 117 18 124C20 119 24 116 29 115C22 120 20 126 19 132C30 127 42 131 50 140C54 143 47 148 53 151C52 159 68 159 67 151C73 148 66 143 70 140C78 131 90 127 101 132C100 126 98 120 91 115C96 116 100 119 102 124C116 117 120 103 114 81C108 61 95 41 98 15C94 20 90 29 89 39C87 55 94 72 98 88C101 99 100 106 92 108C91 102 88 98 82 97L82 103C80 115 66 118 66 105C66 93 73 79 82 70C68 51 63 31 60 3Z" />
          </g>
        </svg>
      </span>
      <span className="uk-brand__hindi" lang="hi" aria-hidden="true">अर्बन काशी</span>
      <span className="uk-brand__english" lang="en" aria-hidden="true">URBAN KASHI</span>
    </span>
  );
}