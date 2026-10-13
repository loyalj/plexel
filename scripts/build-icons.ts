/**
 * Copies the icons the app names (src/ui/icons.ts) out of Phosphor's
 * Iconify data into src/ui/icons.data.ts, which is checked in: the app
 * carries only these outlines and fetches nothing.
 *
 * Run with: npm run build:icons (after changing the registry or updating
 * @iconify-json/ph). check:commands fails while the two disagree.
 */
import { writeFileSync } from 'node:fs'
import { iconBodies, ICON_DATA_FILE, iconDataSource } from './icon-data'

const bodies = iconBodies()
writeFileSync(ICON_DATA_FILE, iconDataSource(bodies))
console.log(`wrote ${Object.keys(bodies).length} icons to ${ICON_DATA_FILE}`)
