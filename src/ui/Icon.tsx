/**
 * An icon from the registry (icons.ts), drawn inline in the current text
 * colour at the current font size: a button sets its size with `font-size`
 * and its colour with `color`, as for text. Decorative: whatever it sits in
 * carries the name (`aria-label` or text).
 */
import { ICON_DATA } from './icons.data'
import { ICONS, hasFilled, type IconName } from './icons'

export function Icon({ name, filled = false, className }: { name: IconName; filled?: boolean; className?: string }) {
  const ph = ICONS[name]
  const body = ICON_DATA[filled && hasFilled(name) ? `${ph}-fill` : ph] ?? ''
  return <svg className={className ? `icon ${className}` : 'icon'} viewBox="0 0 256 256" aria-hidden="true" focusable="false" data-icon={name} dangerouslySetInnerHTML={{ __html: body }} />
}
