/** @author masterzee001 */
/**
 * Line icons for the canon, drawn as strokes so they take any colour and
 * size. Kept to the set the screens actually use; nothing decorative.
 */
import { type JSX } from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

export type IconName =
  | 'chat'
  | 'people'
  | 'programmes'
  | 'conference'
  | 'profile'
  | 'search'
  | 'filter'
  | 'phone'
  | 'phone-in'
  | 'phone-out'
  | 'phone-missed'
  | 'message'
  | 'mic'
  | 'mic-off'
  | 'speaker'
  | 'camera'
  | 'camera-off'
  | 'hangup'
  | 'add-person'
  | 'plus'
  | 'more'
  | 'chevron'
  | 'globe'
  | 'lock'
  | 'shield'
  | 'bell'
  | 'gear'
  | 'translate'
  | 'wave'
  | 'close'
  | 'share'
  | 'calendar'
  | 'clock'
  | 'eye';

export function Icon({
  name,
  size = 22,
  color = '#eef3f7',
  strokeWidth = 1.7,
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly color?: string;
  readonly strokeWidth?: number;
}): JSX.Element {
  const p = { stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'chat' && <Path d="M4 6.5A3.5 3.5 0 0 1 7.5 3h9A3.5 3.5 0 0 1 20 6.5v6a3.5 3.5 0 0 1-3.5 3.5H10l-4.5 4v-4A3.5 3.5 0 0 1 4 12.5z" {...p} />}
      {name === 'people' && (<><Circle cx="9" cy="8" r="3.2" {...p} /><Path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" {...p} /><Circle cx="16.5" cy="9.5" r="2.4" {...p} /><Path d="M17 14.5c2.2.3 3.8 2 3.8 4.5" {...p} /></>)}
      {name === 'programmes' && (<><Rect x="3.5" y="4.5" width="17" height="15" rx="3" {...p} /><Path d="M10.2 9v6l5-3z" {...p} /></>)}
      {name === 'conference' && (<><Circle cx="12" cy="12" r="2.3" {...p} /><Path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 7.5a6.4 6.4 0 0 1 0 9" {...p} /><Path d="M4.5 4.5a10.5 10.5 0 0 0 0 15M19.5 4.5a10.5 10.5 0 0 1 0 15" {...p} /></>)}
      {name === 'profile' && (<><Circle cx="12" cy="9" r="3.4" {...p} /><Path d="M5 20c.7-3.6 3.6-5.5 7-5.5s6.3 1.9 7 5.5" {...p} /><Circle cx="12" cy="12" r="9.5" {...p} /></>)}
      {name === 'search' && (<><Circle cx="10.5" cy="10.5" r="6" {...p} /><Line x1="15" y1="15" x2="20" y2="20" {...p} /></>)}
      {name === 'filter' && (<><Line x1="4" y1="8" x2="20" y2="8" {...p} /><Line x1="4" y1="16" x2="20" y2="16" {...p} /><Circle cx="9" cy="8" r="2" fill="#070b12" stroke={color} strokeWidth={strokeWidth} /><Circle cx="15" cy="16" r="2" fill="#070b12" stroke={color} strokeWidth={strokeWidth} /></>)}
      {(name === 'phone' || name === 'phone-in' || name === 'phone-out' || name === 'phone-missed') && (
        <Path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A15.5 15.5 0 0 1 4.5 5.5a2 2 0 0 1 2-2z" {...p} />
      )}
      {name === 'phone-out' && <Path d="M15 4h5v5M20 4l-6 6" {...p} />}
      {name === 'phone-in' && <Path d="M20 9h-5V4M15 9l6-6" {...p} />}
      {name === 'phone-missed' && <Path d="M15 4l5 5M20 4l-5 5" {...p} />}
      {name === 'message' && <Path d="M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9l-4 3.5V7z" {...p} />}
      {name === 'mic' && (<><Rect x="9" y="3.5" width="6" height="11" rx="3" {...p} /><Path d="M6 11.5a6 6 0 0 0 12 0M12 17.5v3M9 20.5h6" {...p} /></>)}
      {name === 'mic-off' && (<><Rect x="9" y="3.5" width="6" height="11" rx="3" {...p} /><Path d="M6 11.5a6 6 0 0 0 12 0M12 17.5v3M9 20.5h6" {...p} /><Line x1="4" y1="4" x2="20" y2="20" {...p} /></>)}
      {name === 'speaker' && (<><Path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" {...p} /><Path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" {...p} /></>)}
      {name === 'camera' && (<><Rect x="3.5" y="6.5" width="12.5" height="11" rx="2.5" {...p} /><Path d="M16 10.5l4.5-2.5v8L16 13.5z" {...p} /></>)}
      {name === 'camera-off' && (<><Rect x="3.5" y="6.5" width="12.5" height="11" rx="2.5" {...p} /><Path d="M16 10.5l4.5-2.5v8L16 13.5z" {...p} /><Line x1="4" y1="4" x2="20" y2="20" {...p} /></>)}
      {name === 'hangup' && <Path d="M3.5 13.5c4.7-4.7 12.3-4.7 17 0l-2 2.3-3.6-1.4v-2.6a11 11 0 0 0-5.8 0v2.6l-3.6 1.4z" {...p} fill={color} />}
      {name === 'add-person' && (<><Circle cx="10" cy="8.5" r="3.4" {...p} /><Path d="M4 20c.7-3.6 3.2-5.5 6-5.5s5.3 1.9 6 5.5" {...p} /><Path d="M18.5 8v6M15.5 11h6" {...p} /></>)}
      {name === 'plus' && <Path d="M12 5v14M5 12h14" {...p} />}
      {name === 'more' && (<><Circle cx="12" cy="5.5" r="1.4" fill={color} /><Circle cx="12" cy="12" r="1.4" fill={color} /><Circle cx="12" cy="18.5" r="1.4" fill={color} /></>)}
      {name === 'chevron' && <Path d="M9 5l7 7-7 7" {...p} />}
      {name === 'globe' && (<><Circle cx="12" cy="12" r="8.5" {...p} /><Path d="M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17" {...p} /></>)}
      {name === 'lock' && (<><Rect x="5.5" y="10.5" width="13" height="9.5" rx="2.5" {...p} /><Path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" {...p} /></>)}
      {name === 'shield' && (<><Path d="M12 3.5l7 2.5v5.5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z" {...p} /><Path d="M9 12l2 2 4-4" {...p} /></>)}
      {name === 'bell' && (<><Path d="M6.5 16.5v-5a5.5 5.5 0 0 1 11 0v5l1.5 2h-14z" {...p} /><Path d="M10 20.5a2 2 0 0 0 4 0" {...p} /></>)}
      {name === 'gear' && (<><Circle cx="12" cy="12" r="3" {...p} /><Path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M6 18l1.6-1.6M16.4 7.6L18 6" {...p} /></>)}
      {name === 'translate' && (<><Path d="M4 6h8M8 4v2M10.5 6c-.6 3.5-2.8 6.3-6 8M6 9c1.2 2.4 3 4.2 5.5 5.5" {...p} /><Path d="M13 20l3.5-9 3.5 9M14.3 17h4.4" {...p} /></>)}
      {name === 'wave' && <Path d="M4 12h1.5M8 8v8M11 5v14M14 8v8M17 10v4M19.5 12H21" {...p} />}
      {name === 'close' && <Path d="M6 6l12 12M18 6L6 18" {...p} />}
      {name === 'share' && (<><Path d="M12 4v11M8 8l4-4 4 4" {...p} /><Path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" {...p} /></>)}
      {name === 'calendar' && (<><Rect x="4" y="5.5" width="16" height="15" rx="2.5" {...p} /><Path d="M4 10h16M8 3.5v4M16 3.5v4" {...p} /></>)}
      {name === 'clock' && (<><Circle cx="12" cy="12" r="8.5" {...p} /><Path d="M12 7.5V12l3 2" {...p} /></>)}
      {name === 'eye' && (<><Path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" {...p} /><Circle cx="12" cy="12" r="2.6" {...p} /></>)}
    </Svg>
  );
}
