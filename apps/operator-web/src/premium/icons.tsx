/** @author masterzee001 */
/**
 * Line icons for the premium operator console.
 *
 * Drawn to the golden masters (founder directive, LOCKED 30 Aug 2026): a
 * 24-unit grid, 1.75 stroke, round caps and joins, currentColor. Inline SVG
 * rather than an icon font so the console is served from staging with no
 * runtime fetch, and so each glyph inherits the colour of the text beside it.
 *
 * Every icon is decorative by default (aria-hidden); a control that needs a
 * name gives it in its own aria-label, not through the icon.
 */
import React from 'react';

export interface IconProps {
  readonly size?: number | undefined;
  readonly strokeWidth?: number | undefined;
  readonly className?: string | undefined;
  readonly title?: string | undefined;
}

function Svg({
  size = 20,
  strokeWidth = 1.75,
  className,
  title,
  children,
}: IconProps & { readonly children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title === undefined ? true : undefined}
      role={title === undefined ? undefined : 'img'}
      focusable="false"
    >
      {title !== undefined && <title>{title}</title>}
      {children}
    </svg>
  );
}

export const HomeIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M3 11.5 12 4l9 7.5" />
    <path d="M5.5 10v9.5h13V10" />
    <path d="M10 19.5v-5h4v5" />
  </Svg>
);

export const CameraIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <rect x="3" y="7" width="13" height="10" rx="2" />
    <path d="m16 10.5 5-2.5v8l-5-2.5" />
  </Svg>
);

export const GlobeIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18" />
  </Svg>
);

export const WaveformIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10v4" />
  </Svg>
);

export const BookIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5z" />
    <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z" />
  </Svg>
);

export const ClockIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);

export const MegaphoneIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M4 10v4a1 1 0 0 0 1 1h3l8 4V5L8 9H5a1 1 0 0 0-1 1z" />
    <path d="M19 10a3 3 0 0 1 0 4" />
    <path d="M8 15v4" />
  </Svg>
);

export const UsersIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    <path d="M16 4.5a3.5 3.5 0 0 1 0 7" />
    <path d="M17.5 14.5c2.1.7 3.5 2.6 3.5 5.5" />
  </Svg>
);

export const ShieldIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6z" />
  </Svg>
);

export const ShieldCheckIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
);

export const BroadcastIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2" />
    <path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
  </Svg>
);

export const EyeIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const ChevronUpIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="m6 15 6-6 6 6" />
  </Svg>
);

export const ChevronRightIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);

export const ArrowRightIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M4 12h16M13 5l7 7-7 7" />
  </Svg>
);

export const BellIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </Svg>
);

export const AlertIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M12 4 2.8 19.5h18.4z" />
    <path d="M12 10v4M12 17h.01" />
  </Svg>
);

export const InfoIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
);

export const CloseIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const CheckIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const CopyIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
  </Svg>
);

export const ShareIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <circle cx="18" cy="5.5" r="2.5" />
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="18.5" r="2.5" />
    <path d="m8.2 10.8 7.6-4M8.2 13.2l7.6 4" />
  </Svg>
);

export const QrIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <path d="M14 14h2v2h-2zM18 14h2M14 18h2M18 18h2v2" />
  </Svg>
);

export const ExternalLinkIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
  </Svg>
);

export const EditIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z" />
    <path d="m13.5 8.5 3 3" />
  </Svg>
);

export const SearchIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.3-4.3" />
  </Svg>
);

export const PlusIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const UploadIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M12 16V5M7.5 9.5 12 5l4.5 4.5" />
    <path d="M4 15v2a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2" />
  </Svg>
);

export const ScreenIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16.5V20" />
  </Svg>
);

export const LinkIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" />
  </Svg>
);

export const MicIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
  </Svg>
);

export const PlayIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M7 5v14l12-7z" fill="currentColor" stroke="none" />
  </Svg>
);

export const PauseIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M8 5v14M16 5v14" strokeWidth={2.5} />
  </Svg>
);

export const StopIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </Svg>
);

export const RecordIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
  </Svg>
);

export const SubtitlesIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 14h4M13 14h4M7 10.5h2M11 10.5h6" />
  </Svg>
);

export const TranslateIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M4 6h8M8 4v2M10.5 6c-.8 3.2-2.8 5.8-6 7.5" />
    <path d="M6 9c1 2.3 2.8 4 5 5" />
    <path d="m13 20 4-9 4 9M14.3 17h5.4" />
  </Svg>
);

export const DocumentIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M7 3h7l4 4v14H7z" />
    <path d="M14 3v4h4M10 12h5M10 16h5" />
  </Svg>
);

export const LockIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);

export const FullscreenIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
);

export const SparkleIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5l2 2M15.5 15.5l2 2M6.5 17.5l2-2M15.5 8.5l2-2" />
  </Svg>
);

export const HandIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7-6.5 7S5 17.5 5 14v-3a1.5 1.5 0 0 1 3 0" />
  </Svg>
);

export const SettingsIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
);

export const SignalIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M4 18v-3M9 18v-7M14 18V7M19 18V4" strokeWidth={2.5} />
  </Svg>
);

export const WifiOffIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M2 8.5a15 15 0 0 1 5.5-3M22 8.5a15 15 0 0 0-11-3.5M5 12.5a10 10 0 0 1 3.5-2.5M19 12.5a10 10 0 0 0-7-3M8.5 16a5 5 0 0 1 7 0M12 20h.01M3 3l18 18" />
  </Svg>
);

export const SwapIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <path d="M17 3l4 4-4 4M21 7H8a4 4 0 0 0-4 4M7 21l-4-4 4-4M3 17h13a4 4 0 0 0 4-4" />
  </Svg>
);

export const ObsIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3.5a5 5 0 0 1 4.6 7M20.4 12.2a5 5 0 0 1-6.6 5.2M6.6 18.3a5 5 0 0 1 1.3-8.5" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
);

export const CheckCircleIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12.5 2.3 2.3 4.7-5" />
  </Svg>
);

export const CloseCircleIcon = (p: IconProps): React.ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </Svg>
);

export const ICONS = {
  home: HomeIcon,
  camera: CameraIcon,
  globe: GlobeIcon,
  waveform: WaveformIcon,
  book: BookIcon,
  clock: ClockIcon,
  megaphone: MegaphoneIcon,
  users: UsersIcon,
  shield: ShieldIcon,
  'shield-check': ShieldCheckIcon,
  broadcast: BroadcastIcon,
  eye: EyeIcon,
  'chevron-down': ChevronDownIcon,
  'chevron-up': ChevronUpIcon,
  'chevron-right': ChevronRightIcon,
  'arrow-right': ArrowRightIcon,
  bell: BellIcon,
  alert: AlertIcon,
  info: InfoIcon,
  close: CloseIcon,
  check: CheckIcon,
  copy: CopyIcon,
  share: ShareIcon,
  qr: QrIcon,
  'external-link': ExternalLinkIcon,
  edit: EditIcon,
  search: SearchIcon,
  plus: PlusIcon,
  upload: UploadIcon,
  screen: ScreenIcon,
  link: LinkIcon,
  mic: MicIcon,
  play: PlayIcon,
  pause: PauseIcon,
  stop: StopIcon,
  record: RecordIcon,
  subtitles: SubtitlesIcon,
  translate: TranslateIcon,
  document: DocumentIcon,
  lock: LockIcon,
  fullscreen: FullscreenIcon,
  sparkle: SparkleIcon,
  hand: HandIcon,
  settings: SettingsIcon,
  signal: SignalIcon,
  'wifi-off': WifiOffIcon,
  obs: ObsIcon,
  'check-circle': CheckCircleIcon,
  'close-circle': CloseCircleIcon,
  swap: SwapIcon,
} as const;

export type IconName = keyof typeof ICONS;

/** One icon by name, for tables that map state to a glyph. */
export function Icon({ name, ...rest }: IconProps & { readonly name: IconName }): React.ReactElement {
  const Component = ICONS[name];
  return <Component {...rest} />;
}
